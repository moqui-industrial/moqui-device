"""Loopback-only HTTP fixture for MR-Moqui's gateway wrapper contract specs."""
from http.server import BaseHTTPRequestHandler, HTTPServer
import json

class Handler(BaseHTTPRequestHandler):
    def do_POST(self):
        body = self.rfile.read(int(self.headers.get('Content-Length', '0')))
        if self.path == '/fail':
            self.send_response(503)
            self.end_headers()
            return
        value = {'body': json.loads(body or b'{}'), 'apiKey': self.headers.get('X-API-Key'),
                 'query': self.path.partition('?')[2]}
        if self.path == '/act':
            parsed = json.loads(body)
            value = {'action':[1,2,3], 'modelId':'bytes:' + parsed['image_base64']}
        if self.path == '/ground':
            value = {'boundingBox':[1,2,3,4], 'center':[2,3], 'targetPose':[1,2,3,0,0,0], 'objectLabel':'fixture'}
        if self.path == '/plan':
            value = {'waypoints':[[0,0,0,0,0,0],[1,2,3,0,0,0]]}
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.end_headers()
        self.wfile.write(json.dumps(value).encode())
    def log_message(self, *args):
        pass

if __name__ == '__main__':
    import argparse
    parser = argparse.ArgumentParser()
    parser.add_argument('--port', type=int, default=18091)
    args = parser.parse_args()
    HTTPServer(('127.0.0.1', args.port), Handler).serve_forever()
