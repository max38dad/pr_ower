from flask import Flask, request, Response, jsonify
import requests
import socket

app = Flask(__name__)

@app.route('/', defaults={'path': ''}, methods=['GET', 'POST', 'PUT', 'DELETE', 'PATCH'])
@app.route('/<path:path>', methods=['GET', 'POST', 'PUT', 'DELETE', 'PATCH'])
def proxy(path):
    # Se non viene passato l'header X-Target-Url, restituiamo le info del container
    target_url = request.headers.get('X-Target-Url')
    
    if not target_url:
        # Raccogliamo informazioni utili sul container corrente
        container_info = {
            "message": "Bunny CDN Magic Container Proxy is Running!",
            "container_ip": "Sconosciuto",
            "headers_received": dict(request.headers)
        }
        
        # Proviamo a ottenere l'IP pubblico del container
        try:
            ip_resp = requests.get('https://api.ipify.org?format=json', timeout=5)
            if ip_resp.status_code == 200:
                container_info["container_ip"] = ip_resp.json().get("ip")
        except:
            pass
            
        return jsonify(container_info), 200

    try:
        # Rimuove gli header che non vogliamo inoltrare al target
        headers_to_forward = {}
        for key, value in request.headers:
            key_lower = key.lower()
            # Rimuoviamo tutti gli header che possono rivelare l'IP o che sono specifici della CDN
            if key_lower not in ['host', 'x-target-url', 'connection', 'content-length'] and not key_lower.startswith('x-forwarded-') and not key_lower.startswith('cdn-') and key_lower not in ['x-real-ip', 'true-client-ip', 'cf-connecting-ip']:
                headers_to_forward[key] = value

        # Leggiamo il timeout richiesto dal client (default 5 se non specificato)
        client_timeout = request.headers.get('X-Proxy-Timeout')
        try:
            timeout_val = float(client_timeout) if client_timeout else 5.0
        except:
            timeout_val = 5.0

        # Inoltra la richiesta al target
        resp = requests.request(
            method=request.method,
            url=target_url,
            headers=headers_to_forward,
            data=request.get_data(),
            cookies=request.cookies,
            allow_redirects=False,
            verify=False,
            timeout=timeout_val
        )

        # Rimuove gli header hop-by-hop dalla risposta
        excluded_headers = ['content-encoding', 'content-length', 'transfer-encoding', 'connection']
        headers = [(name, value) for (name, value) in resp.raw.headers.items()
                   if name.lower() not in excluded_headers]

        return Response(resp.content, resp.status_code, headers)
    except Exception as e:
        return f"Errore nel proxy: {str(e)}", 500

import os

if __name__ == '__main__':
    # Legge la porta dalla variabile d'ambiente PORT, altrimenti usa 8080 di default
    port = int(os.environ.get('PORT', 8080))
    app.run(host='0.0.0.0', port=port)
