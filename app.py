from flask import Flask, send_from_directory
import os

app = Flask(__name__)

# Aponte para a pasta específica do seu site
STATIC_DIR = '/var/www/html/EncantadasWebsite'

@app.route('/')
def index():
    return send_from_directory(STATIC_DIR, 'index.html')

@app.route('/<path:path>')
def serve_static(path):
    return send_from_directory(STATIC_DIR, path)

if __name__ == '__main__':
    app.run(host='0.0.0.0', port=8081, debug=False)