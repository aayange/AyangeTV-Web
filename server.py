#!/usr/bin/env python3
"""AyangeTV Local Server - serves static files and proxies IPTV streams."""

import http.server
import urllib.request
import urllib.error
import gzip
import json
import os
import re
import subprocess
import threading
import time
from urllib.parse import urlparse, parse_qs, urlencode

PORT = int(os.environ.get('PORT', 8080))
IPTV_SERVER = "http://line.tsclean.cc"
CONFIG_USER = "REDACTED"
CONFIG_PASS = "REDACTED"
USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
# OpenSubtitles requires a User-Agent identifying the app — they reject the browser default.
OS_USER_AGENT = "AyangeTV v1.0"
OS_API = "https://api.opensubtitles.com/api/v1"

# Map segment hashes to their backend base URL
_hash_backend = {}
_hash_lock = threading.Lock()


class CaptureRedirectHandler(urllib.request.HTTPRedirectHandler):
    """Stop auto-following redirects; store the Location URL instead."""
    def http_error_302(self, req, fp, code, msg, headers):
        self.redirect_url = headers.get('Location')
        return fp
    http_error_301 = http_error_303 = http_error_307 = http_error_302


def fetch_with_redirect(url, extra_headers=None, timeout=30):
    """Fetch a URL, manually following one redirect to avoid ISP interception."""
    handler = CaptureRedirectHandler()
    opener = urllib.request.build_opener(handler)
    req = urllib.request.Request(url)
    req.add_header('User-Agent', USER_AGENT)
    if extra_headers:
        for k, v in extra_headers.items():
            req.add_header(k, v)

    resp = opener.open(req, timeout=timeout)
    redirect_url = getattr(handler, 'redirect_url', None)
    if redirect_url:
        req2 = urllib.request.Request(redirect_url)
        req2.add_header('User-Agent', USER_AGENT)
        if extra_headers:
            for k, v in extra_headers.items():
                req2.add_header(k, v)
        resp.close()
        resp = urllib.request.urlopen(req2, timeout=timeout)
        resp.redirect_url = redirect_url
    else:
        resp.redirect_url = None
    return resp


class AyangeTVHandler(http.server.SimpleHTTPRequestHandler):
    """Serves static files and proxies IPTV API, streams, and HLS segments."""

    def end_headers(self):
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Cache-Control', 'no-cache, no-store, must-revalidate')
        super().end_headers()

    def do_OPTIONS(self):
        self.send_response(200)
        self.send_header('Access-Control-Allow-Methods', 'GET, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Range, Accept, X-OS-Key')
        self.end_headers()

    def do_GET(self):
        if self.path.startswith('/transcode/'):
            self.proxy_transcode()
        elif self.path.startswith('/subtitles/'):
            self.proxy_subtitles()
        elif self.path.startswith('/subs/search'):
            self.proxy_os_search()
        elif self.path.startswith('/subs/get'):
            self.proxy_os_download()
        elif self.path.startswith(('/live/', '/movie/', '/series/')):
            self.proxy_stream()
        elif self.path.startswith('/player_api.php'):
            self.proxy_simple()
        elif self.path.startswith('/hls/'):
            self.proxy_hls_segment()
        else:
            super().do_GET()

    def proxy_simple(self):
        """Proxy API calls."""
        target_url = IPTV_SERVER + self.path
        try:
            req = urllib.request.Request(target_url)
            req.add_header('User-Agent', USER_AGENT)
            resp = urllib.request.urlopen(req, timeout=30)
            self.send_response(resp.status)
            for key, val in resp.getheaders():
                if key.lower() not in ('transfer-encoding', 'connection'):
                    self.send_header(key, val)
            self.end_headers()
            self.wfile.write(resp.read())
            resp.close()
        except Exception as e:
            self.send_error(502, f"Proxy error: {e}")

    def proxy_stream(self):
        """Proxy stream requests — manually follows redirects, rewrites m3u8, supports Range."""
        target_url = IPTV_SERVER + self.path
        try:
            extra = {}
            for header in ['Range', 'Accept']:
                val = self.headers.get(header)
                if val:
                    extra[header] = val
            # Force identity — upstream-side compression breaks the m3u8
            # rewriter and saves no bytes when the proxy is co-located.
            extra['Accept-Encoding'] = 'identity'

            resp = fetch_with_redirect(target_url, extra_headers=extra, timeout=60)
            content_type = resp.headers.get('Content-Type', 'application/octet-stream')

            # Determine backend from redirect
            redirect_url = getattr(resp, 'redirect_url', None)
            if redirect_url:
                parsed = urlparse(redirect_url)
                backend_base = f"{parsed.scheme}://{parsed.netloc}"
            else:
                backend_base = IPTV_SERVER

            # Detect m3u8 playlist
            is_m3u8 = ('m3u8' in content_type or 'mpegurl' in content_type.lower()
                        or self.path.endswith('.m3u8'))

            if is_m3u8:
                raw = resp.read()
                resp.close()

                # Defensively decompress — some upstreams ignore identity.
                if resp.headers.get('Content-Encoding') == 'gzip' or raw[:2] == b'\x1f\x8b':
                    try:
                        raw = gzip.decompress(raw)
                    except OSError:
                        pass

                body = raw.decode('utf-8', errors='replace')
                stripped = body.lstrip()

                # Validate it's a real playlist. Empty / non-m3u8 bodies
                # mean the upstream rejected us (datacenter IP block,
                # session expired, channel offline) — surface a real error
                # instead of feeding garbage to HLS.js.
                if not stripped.startswith('#EXTM3U'):
                    if stripped.startswith('<!') or stripped.startswith('<html'):
                        self.send_error(503, "Stream unavailable")
                    else:
                        snippet = stripped[:120].replace('\n', ' ') if stripped else '(empty body)'
                        self.send_error(502, f"Upstream returned no playlist: {snippet}")
                    return

                # Record hash->backend for every segment
                for match in re.finditer(r'/hls/([a-f0-9]+)/', body):
                    with _hash_lock:
                        _hash_backend[match.group(1)] = backend_base

                # Rewrite absolute URLs to relative
                body = re.sub(r'https?://[^/\s]+(/[^\s]*)', r'\1', body)
                encoded = body.encode('utf-8')

                self.send_response(200)
                self.send_header('Content-Type', 'application/vnd.apple.mpegurl')
                self.send_header('Content-Length', str(len(encoded)))
                self.end_headers()
                try:
                    self.wfile.write(encoded)
                except (BrokenPipeError, ConnectionResetError):
                    pass
            else:
                # VOD / direct stream — pass through with Range support
                status = resp.status
                self.send_response(status)
                self.send_header('Content-Type', content_type)

                # Pass through important headers for video seeking
                for h in ['Content-Length', 'Content-Range', 'Accept-Ranges']:
                    val = resp.headers.get(h)
                    if val:
                        self.send_header(h, val)
                if not resp.headers.get('Accept-Ranges'):
                    self.send_header('Accept-Ranges', 'bytes')
                self.end_headers()

                while True:
                    chunk = resp.read(131072)
                    if not chunk:
                        break
                    try:
                        self.wfile.write(chunk)
                    except (BrokenPipeError, ConnectionResetError):
                        break
                resp.close()

        except urllib.error.HTTPError as e:
            self.send_error(e.code, str(e.reason))
        except Exception as e:
            self.send_error(502, f"Proxy error: {e}")

    def proxy_transcode(self):
        """Transcode stream so browsers can play it.

        Probes the source to decide whether to copy or re-encode video. Audio
        is always re-encoded to AAC (covers AC3/EAC3/DTS/Opus sources).

        URL: /transcode/<type>/<id>.<ext>  (e.g. /transcode/series/12345.mkv)
        """
        match = re.match(r'/transcode/(series|movie)/(\d+)\.(\w+)', self.path)
        if not match:
            self.send_error(400, "Bad transcode URL")
            return

        stream_type, stream_id, ext = match.groups()
        force = parse_qs(urlparse(self.path).query).get('force', [''])[0]  # ?force=h264 to skip probe
        if stream_type == 'series':
            source_url = f"{IPTV_SERVER}/series/{CONFIG_USER}/{CONFIG_PASS}/{stream_id}.{ext}"
        else:
            source_url = f"{IPTV_SERVER}/movie/{CONFIG_USER}/{CONFIG_PASS}/{stream_id}.{ext}"

        # Resolve redirect to get actual backend URL
        try:
            handler = CaptureRedirectHandler()
            opener = urllib.request.build_opener(handler)
            req = urllib.request.Request(source_url)
            req.add_header('User-Agent', USER_AGENT)
            opener.open(req, timeout=10)
            actual_url = getattr(handler, 'redirect_url', None) or source_url
        except Exception:
            actual_url = source_url

        # Probe codecs so we know whether to copy or re-encode the video.
        # Browsers can play H.264/AVC; HEVC/H.265, VP9 etc. need re-encoding.
        video_codec = ''
        try:
            probe = subprocess.run(
                ['ffprobe', '-v', 'error',
                 '-headers', f'User-Agent: {USER_AGENT}\r\n',
                 '-select_streams', 'v:0',
                 '-show_entries', 'stream=codec_name,height',
                 '-of', 'default=noprint_wrappers=1',
                 actual_url],
                capture_output=True, timeout=8
            )
            for line in probe.stdout.decode('utf-8', errors='replace').splitlines():
                if line.startswith('codec_name='):
                    video_codec = line.split('=', 1)[1].strip().lower()
        except Exception as e:
            print(f'[transcode] probe failed for {stream_id}: {e}')

        # H.264 plays everywhere; everything else gets re-encoded.
        copy_video = video_codec in ('h264', 'avc1', 'avc') and force != 'h264'
        print(f'[transcode] {stream_type}/{stream_id}  video={video_codec or "?"}  mode={"copy" if copy_video else "h264 re-encode"}')

        cmd = [
            'ffmpeg', '-hide_banner', '-loglevel', 'warning',
            '-fflags', '+genpts+igndts',
            '-headers', f'User-Agent: {USER_AGENT}\r\n',
            '-i', actual_url,
            '-map', '0:v:0',
            '-map', '0:a:0?',
        ]
        if copy_video:
            cmd += ['-c:v', 'copy']
        else:
            # ultrafast + zerolatency keeps the encoder caught up with the source so
            # the browser starts receiving fragments quickly. Frequent keyframes
            # (-g 48 ≈ 2s @ 24fps) mean the fragmented MP4 muxer can flush often
            # enough that the player doesn't time out on the first segment.
            # Two-stage scale: cap to 1080p (preserve aspect), then force even dims.
            cmd += [
                '-c:v', 'libx264',
                '-preset', 'ultrafast',
                '-tune', 'zerolatency',
                '-crf', '26',
                '-g', '48', '-keyint_min', '48', '-sc_threshold', '0',
                '-vf', 'scale=1920:1080:force_original_aspect_ratio=decrease,scale=trunc(iw/2)*2:trunc(ih/2)*2',
                '-pix_fmt', 'yuv420p',
                '-profile:v', 'main', '-level', '4.0',
            ]
        cmd += [
            '-c:a', 'aac', '-b:a', '192k', '-ac', '2',
            # Streaming fMP4: emit moov immediately, fragment on every keyframe.
            # +faststart is the OPPOSITE (re-muxes moov to start after writing
            # everything) and silently produces a broken file in a streaming pipe.
            '-movflags', 'frag_keyframe+empty_moov+default_base_moof',
            '-f', 'mp4',
            'pipe:1'
        ]

        try:
            proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            # Drain stderr fully — both for visibility and so the pipe buffer
            # doesn't fill and deadlock the encoder.
            def _drain():
                try:
                    for line in iter(proc.stderr.readline, b''):
                        s = line.decode('utf-8', errors='replace').strip()
                        if s:
                            print(f'[ffmpeg {stream_id}] {s}')
                except Exception:
                    pass
            threading.Thread(target=_drain, daemon=True).start()

            self.send_response(200)
            self.send_header('Content-Type', 'video/mp4')
            self.send_header('Transfer-Encoding', 'chunked')
            self.end_headers()

            t0 = time.time()
            first_chunk = True
            total_bytes = 0
            client_disconnect = False
            while True:
                chunk = proc.stdout.read(131072)
                if not chunk:
                    break
                if first_chunk:
                    print(f'[transcode {stream_id}] first byte after {time.time()-t0:.1f}s')
                    first_chunk = False
                total_bytes += len(chunk)
                try:
                    self.wfile.write(f'{len(chunk):X}\r\n'.encode())
                    self.wfile.write(chunk)
                    self.wfile.write(b'\r\n')
                except (BrokenPipeError, ConnectionResetError):
                    client_disconnect = True
                    proc.kill()
                    break

            try:
                self.wfile.write(b'0\r\n\r\n')
            except Exception:
                pass
            rc = proc.wait()
            elapsed = time.time() - t0
            mb = total_bytes / 1_048_576
            tag = 'client-gave-up' if client_disconnect else f'ffmpeg-rc={rc}'
            print(f'[transcode {stream_id}] {tag}  served={mb:.1f}MB  in={elapsed:.1f}s')

        except Exception as e:
            self.send_error(502, f"Transcode error: {e}")

    def proxy_subtitles(self):
        """Extract subtitles from a stream as WebVTT.
        URL: /subtitles/<type>/<id>.<ext>?track=0
        """
        match = re.match(r'/subtitles/(series|movie)/(\d+)\.(\w+)', self.path.split('?')[0])
        if not match:
            self.send_error(400, "Bad subtitle URL")
            return

        stream_type, stream_id, ext = match.groups()
        qs = parse_qs(urlparse(self.path).query)
        track = qs.get('track', ['0'])[0]

        if stream_type == 'series':
            source_url = f"{IPTV_SERVER}/series/{CONFIG_USER}/{CONFIG_PASS}/{stream_id}.{ext}"
        else:
            source_url = f"{IPTV_SERVER}/movie/{CONFIG_USER}/{CONFIG_PASS}/{stream_id}.{ext}"

        try:
            handler = CaptureRedirectHandler()
            opener = urllib.request.build_opener(handler)
            req = urllib.request.Request(source_url)
            req.add_header('User-Agent', USER_AGENT)
            opener.open(req, timeout=10)
            actual_url = getattr(handler, 'redirect_url', None) or source_url
        except Exception:
            actual_url = source_url

        try:
            cmd = [
                'ffmpeg', '-hide_banner', '-loglevel', 'error',
                '-headers', f'User-Agent: {USER_AGENT}\r\n',
                '-i', actual_url,
                '-map', f'0:s:{track}',
                '-f', 'webvtt',
                'pipe:1'
            ]
            result = subprocess.run(cmd, capture_output=True, timeout=30)

            if result.returncode == 0 and result.stdout:
                self.send_response(200)
                self.send_header('Content-Type', 'text/vtt')
                self.send_header('Content-Length', str(len(result.stdout)))
                self.end_headers()
                self.wfile.write(result.stdout)
            else:
                self.send_error(404, "No subtitles found")

        except Exception as e:
            self.send_error(502, f"Subtitle error: {e}")

    def proxy_os_search(self):
        """Proxy OpenSubtitles search. Client passes its API key in X-OS-Key header.
        Query: /subs/search?q=Title&lang=en&year=2026&imdb=tt1234567
        """
        api_key = self.headers.get('X-OS-Key', '').strip()
        if not api_key:
            self.send_error(401, 'Missing X-OS-Key header')
            return

        qs = parse_qs(urlparse(self.path).query)
        query = (qs.get('q', [''])[0] or '').strip()
        lang = qs.get('lang', ['en'])[0]
        year = qs.get('year', [''])[0]
        imdb = qs.get('imdb', [''])[0]
        if not query and not imdb:
            self.send_error(400, 'q or imdb required')
            return

        params = {'languages': lang}
        if query:
            params['query'] = query
        if year:
            params['year'] = year
        if imdb:
            params['imdb_id'] = imdb.lstrip('t')

        try:
            req = urllib.request.Request(f'{OS_API}/subtitles?{urlencode(params)}')
            req.add_header('Api-Key', api_key)
            req.add_header('User-Agent', OS_USER_AGENT)
            req.add_header('Accept', 'application/json')
            resp = urllib.request.urlopen(req, timeout=15)
            body = resp.read()
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        except urllib.error.HTTPError as e:
            err_body = e.read() if hasattr(e, 'read') else b''
            self.send_response(e.code)
            self.send_header('Content-Type', 'application/json')
            self.end_headers()
            self.wfile.write(err_body or json.dumps({'error': str(e.reason)}).encode())
        except Exception as e:
            self.send_error(502, f'OpenSubtitles search error: {e}')

    def proxy_os_download(self):
        """Two-step: POST /download to get a real download link, then fetch it.
        Returns subtitle text (caller converts SRT→VTT in browser).
        Query: /subs/get?file_id=12345
        """
        api_key = self.headers.get('X-OS-Key', '').strip()
        if not api_key:
            self.send_error(401, 'Missing X-OS-Key header')
            return

        qs = parse_qs(urlparse(self.path).query)
        file_id = qs.get('file_id', [''])[0]
        if not file_id.isdigit():
            self.send_error(400, 'Numeric file_id required')
            return

        try:
            payload = json.dumps({'file_id': int(file_id)}).encode()
            req = urllib.request.Request(f'{OS_API}/download', data=payload, method='POST')
            req.add_header('Api-Key', api_key)
            req.add_header('User-Agent', OS_USER_AGENT)
            req.add_header('Content-Type', 'application/json')
            req.add_header('Accept', 'application/json')
            resp = urllib.request.urlopen(req, timeout=15)
            data = json.loads(resp.read().decode('utf-8'))
            link = data.get('link')
            if not link:
                self.send_error(502, 'OpenSubtitles returned no link')
                return

            # Fetch the actual subtitle file (usually .srt)
            req2 = urllib.request.Request(link)
            req2.add_header('User-Agent', OS_USER_AGENT)
            resp2 = urllib.request.urlopen(req2, timeout=20)
            sub_body = resp2.read()
            self.send_response(200)
            self.send_header('Content-Type', 'text/plain; charset=utf-8')
            self.send_header('Content-Length', str(len(sub_body)))
            self.end_headers()
            self.wfile.write(sub_body)
        except urllib.error.HTTPError as e:
            err_body = e.read() if hasattr(e, 'read') else b''
            self.send_response(e.code)
            self.send_header('Content-Type', 'application/json')
            self.end_headers()
            self.wfile.write(err_body or json.dumps({'error': str(e.reason)}).encode())
        except Exception as e:
            self.send_error(502, f'OpenSubtitles download error: {e}')

    def proxy_hls_segment(self):
        """Proxy HLS .ts segments to the correct backend."""
        hash_match = re.search(r'/hls/([a-f0-9]+)/', self.path)
        backend_base = None
        if hash_match:
            with _hash_lock:
                backend_base = _hash_backend.get(hash_match.group(1))

        if not backend_base:
            self.send_error(404, "Unknown segment")
            return

        target_url = backend_base + self.path
        try:
            req = urllib.request.Request(target_url)
            req.add_header('User-Agent', USER_AGENT)
            resp = urllib.request.urlopen(req, timeout=20)
            self.send_response(resp.status)
            self.send_header('Content-Type', resp.headers.get('Content-Type', 'video/mp2t'))
            cl = resp.headers.get('Content-Length')
            if cl:
                self.send_header('Content-Length', cl)
            self.end_headers()
            while True:
                chunk = resp.read(131072)
                if not chunk:
                    break
                try:
                    self.wfile.write(chunk)
                except (BrokenPipeError, ConnectionResetError):
                    break
            resp.close()
        except Exception as e:
            self.send_error(502, f"Segment proxy error: {e}")

    def log_message(self, format, *args):
        try:
            msg = str(args[0]) if args else ''
            if '/hls/' in msg:
                return
        except (IndexError, AttributeError):
            pass
        super().log_message(format, *args)


class ThreadedServer(http.server.HTTPServer):
    def process_request(self, request, client_address):
        thread = threading.Thread(target=self.process_request_thread, args=(request, client_address))
        thread.daemon = True
        thread.start()

    def process_request_thread(self, request, client_address):
        try:
            self.finish_request(request, client_address)
        except Exception:
            self.handle_error(request, client_address)
        finally:
            self.shutdown_request(request)


if __name__ == '__main__':
    os.chdir(os.path.dirname(os.path.abspath(__file__)))
    server = ThreadedServer(('0.0.0.0', PORT), AyangeTVHandler)
    print(f"\n  AyangeTV Server running on port {PORT}")
    print(f"  Proxying IPTV from {IPTV_SERVER}\n")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n  Server stopped.")
        server.shutdown()
