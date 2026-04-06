import http.server
import socketserver
import os

os.chdir(os.path.dirname(os.path.abspath(__file__)))
handler = http.server.SimpleHTTPRequestHandler
with socketserver.TCPServer(("", 8765), handler) as httpd:
    httpd.serve_forever()
