"""Opt-in local CPU embedding endpoint. Downloads model weights on first start."""

import argparse
import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from fastembed import TextEmbedding


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--port', type=int, default=18562)
    parser.add_argument('--model', default='BAAI/bge-small-en-v1.5')
    parser.add_argument('--cache-dir', default=None)
    parser.add_argument('--reranker', action='store_true', help='Also load the optional local cross-encoder')
    parser.add_argument('--reranker-model', default='ms-marco-MiniLM-L-12-v2')
    parser.add_argument('--threads', type=int, default=2, choices=range(1, 17))
    args = parser.parse_args()
    model = TextEmbedding(model_name=args.model, cache_dir=args.cache_dir, threads=args.threads)
    list(model.embed(['Model Logger embedding warmup']))
    ranker = None
    rerank_request = None
    if args.reranker:
        from flashrank import Ranker, RerankRequest
        from flashrank.Config import model_file_map
        import onnxruntime as ort
        ranker = Ranker(model_name=args.reranker_model, cache_dir=args.cache_dir or '/tmp/model-worklog-reranker', max_length=512)
        # FlashRank's default session uses every CPU core. Bound local inference
        # threads while retaining the same model, tokenizer and ranking scores.
        ranker.session = None
        options = ort.SessionOptions()
        options.intra_op_num_threads = args.threads
        options.inter_op_num_threads = 1
        ranker.session = ort.InferenceSession(str(ranker.model_dir / model_file_map[args.reranker_model]), sess_options=options, providers=['CPUExecutionProvider'])
        rerank_request = RerankRequest
    lock = threading.Lock()

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_args):
            pass

        def reply(self, status, body):
            payload = json.dumps(body, allow_nan=False).encode('utf-8')
            self.send_response(status)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', str(len(payload)))
            self.send_header('Cache-Control', 'no-store')
            self.end_headers()
            self.wfile.write(payload)

        def do_GET(self):
            if self.path == '/health':
                self.reply(200, {'ready': True, 'model': args.model, 'reranker': ranker is not None})
            else:
                self.reply(404, {'error': 'Not found'})

        def do_POST(self):
            if self.path not in ['/v1/embeddings', '/v1/rerank'] or self.headers.get('Origin'):
                self.reply(403, {'error': 'Only direct local embedding requests are accepted'})
                return
            try:
                length = int(self.headers.get('Content-Length', '0'))
                if not 0 < length <= 512 * 1024:
                    raise ValueError('Invalid body size')
                body = json.loads(self.rfile.read(length))
                if self.path == '/v1/rerank':
                    documents = body['documents']
                    if ranker is None or body.get('model') != args.reranker_model or not isinstance(body.get('query'), str) or len(body['query']) > 4000:
                        raise ValueError('Invalid reranking model or query')
                    if not isinstance(documents, list) or not 1 <= len(documents) <= 60 or any(not isinstance(doc.get('id'), str) or not isinstance(doc.get('text'), str) or len(doc['text']) > 1800 for doc in documents):
                        raise ValueError('Invalid reranking documents')
                    with lock:
                        ranked = ranker.rerank(rerank_request(query=body['query'], passages=documents))
                    self.reply(200, {'results': [{'id': item['id'], 'score': float(item['score'])} for item in ranked]})
                    return
                texts = body['input']
                if body.get('model') != args.model or not isinstance(texts, list) or not 1 <= len(texts) <= 16:
                    raise ValueError('Invalid model or batch')
                if any(not isinstance(text, str) or not text or len(text) > 4000 for text in texts):
                    raise ValueError('Invalid embedding input')
                with lock:
                    vectors = [vector.tolist() for vector in model.embed(texts)]
                self.reply(200, {'object': 'list', 'model': args.model, 'data': [{'object': 'embedding', 'index': index, 'embedding': vector} for index, vector in enumerate(vectors)]})
            except (KeyError, TypeError, ValueError, json.JSONDecodeError):
                self.reply(400, {'error': 'Invalid embedding request'})

    server = ThreadingHTTPServer(('127.0.0.1', args.port), Handler)
    server.daemon_threads = True
    server.timeout = 30
    print(f'Local embeddings ready: http://127.0.0.1:{args.port}/v1/embeddings ({args.model})', flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == '__main__':
    main()
