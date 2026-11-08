import json, os, subprocess, tempfile, select, time, threading
from pathlib import Path
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
requests = []
hold_followup = False
parallel_case = False
followup_started = threading.Event()
release_followup = threading.Event()
class Handler(BaseHTTPRequestHandler):
  def log_message(self, *args): pass
  def do_POST(self):
    requests.append(json.loads(self.rfile.read(int(self.headers['Content-Length']))))
    self.send_response(200); self.send_header('Content-Type','text/event-stream'); self.end_headers()
    if hold_followup and len(requests) == 2:
      followup_started.set()
      if not release_followup.wait(10): raise TimeoutError('follow-up was not released')
    base={'id':'test','object':'chat.completion.chunk','created':1,'model':'test-model'}
    if len(requests) == 1:
      args = json.dumps({'question': 'Pick one', 'options': ['A', 'B'], 'mode': 'async'})
      tools = [{'index': 0, 'id': 'call_1', 'type': 'function', 'function': {'name': 'ask_user', 'arguments': args}}]
      if parallel_case:
        tools = [{'index': 0, 'id': 'wait_1', 'type': 'function', 'function': {'name': 'bash', 'arguments': json.dumps({'command': 'sleep 2'})}}, {**tools[0], 'index': 1}]
      events = [{'role': 'assistant', 'tool_calls': tools}, {}]
      finish = 'tool_calls'
    else:
      events = [{'role': 'assistant', 'content': 'OK'}, {}]
      finish = 'stop'
    for chunk in [{**base, 'choices': [{'index': 0, 'delta': events[0], 'finish_reason': None}]}, {**base, 'choices': [{'index': 0, 'delta': events[1], 'finish_reason': finish}]}, '[DONE]']:
      self.wfile.write(('data: '+(chunk if isinstance(chunk,str) else json.dumps(chunk))+'\n\n').encode())
    self.wfile.flush()
server=ThreadingHTTPServer(('127.0.0.1',0),Handler)
threading.Thread(target=server.serve_forever,daemon=True).start()
temp_dir=tempfile.TemporaryDirectory(prefix='pi-ask-e2e-')
tmp=temp_dir.name; session=tmp+'/session.jsonl'
clients=[]
env={**os.environ,'PI_CODING_AGENT_DIR':tmp+'/config','PI_OFFLINE':'1','ASK_FAKE_PORT':str(server.server_port)}
class Client:
 def __init__(self):
  self.p=subprocess.Popen(['pi','--mode','rpc','--no-skills','--session',session,'--provider','ask-test','--model','test-model','-e',str(Path(__file__).parent / 'fixtures' / 'pi-harness.ts')],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,env=env,bufsize=0)
  self.buf=b''
  self.events=[]
  clients.append(self)
 def send(self,x): self.p.stdin.write((json.dumps(x)+'\n').encode()); self.p.stdin.flush()
 def until(self,predicate):
  deadline=time.monotonic()+12
  while time.monotonic()<deadline:
   if b'\n' not in self.buf:
    if not select.select([self.p.stdout],[],[],1)[0]: continue
    chunk=os.read(self.p.stdout.fileno(),65536)
    if not chunk: raise Exception('Pi exited: '+self.p.stderr.read().decode())
    self.buf+=chunk; continue
   line,self.buf=self.buf.split(b'\n',1); event=json.loads(line); self.events.append(event)
   if event.get('type')=='extension_error': raise Exception(str(event))
   if predicate(event): return event
  raise Exception('timeout')
 def close(self):
  if self.p.poll() is not None: return
  self.p.stdin.close()
  try: self.p.wait(timeout=5)
  except subprocess.TimeoutExpired:
   self.p.kill(); self.p.wait(timeout=5)
try:
 c=Client(); c.send({'id':'init','type':'prompt','message':'hello'})
 c.until(lambda x:x.get('type')=='agent_settled')
 c.close()
 c=Client()
 c.until(lambda x:x.get('method')=='setWidget' and '#1 Pick one' in str(x.get('widgetLines')))
 c.send({'id':'answer','type':'prompt','message':'/answer 1'})
 req=c.until(lambda x:x.get('method')=='select')
 c.send({'type':'extension_ui_response','id':req['id'],'value':'2. B'})
 c.until(lambda x:x.get('type')=='message_start' and x.get('message',{}).get('role')=='user' and 'B' in str(x.get('message',{}).get('content')))
 c.until(lambda x:x.get('type')=='agent_settled'); c.close()
 assert any(message.get('role') == 'user' and '質問 #1' in json.dumps(message.get('content'), ensure_ascii=False) and 'B' in json.dumps(message.get('content'), ensure_ascii=False) for req in requests for message in req.get('messages', [])), requests
 c=Client(); c.send({'id':'again','type':'prompt','message':'/answer 1'})
 notice=c.until(lambda x:x.get('method')=='notify')
 assert 'ありません' in notice.get('message',''), notice
 c.close()
 # Start a fresh session and hold the model's follow-up request open.
 requests.clear(); hold_followup = True; session = tmp + '/streaming.jsonl'
 c=Client(); c.send({'id':'stream','type':'prompt','message':'hello'})
 assert followup_started.wait(10), 'model follow-up did not start'
 c.send({'id':'answer-stream','type':'prompt','message':'/answer 1','streamingBehavior':'steer'})
 req=c.until(lambda x:x.get('method')=='select')
 c.send({'type':'extension_ui_response','id':req['id'],'value':'1. A'})
 c.until(lambda x:x.get('id')=='answer-stream' and x.get('type')=='response' and x.get('success'))
 release_followup.set()
 c.until(lambda x:x.get('type')=='message_start' and x.get('message',{}).get('role')=='user' and '質問 #1' in str(x.get('message',{}).get('content')))
 c.until(lambda x:x.get('type')=='agent_settled'); c.close()
 assert any(message.get('role') == 'user' and '質問 #1' in json.dumps(message.get('content'), ensure_ascii=False) for req in requests for message in req.get('messages', [])), requests
 # The pending question must be displayed while an earlier, independent tool is still running.
 requests.clear(); hold_followup = False; parallel_case = True; session = tmp + '/parallel.jsonl'
 c=Client(); c.send({'id':'parallel','type':'prompt','message':'hello'})
 c.until(lambda x:x.get('method')=='setWidget' and '#1 Pick one' in str(x.get('widgetLines')))
 assert not any(x.get('type') == 'tool_execution_end' and x.get('toolName') == 'bash' for x in c.events), c.events
 c.until(lambda x:x.get('type')=='agent_settled'); c.close()
 print('Pi RPC: session restoration, idle/streaming answers, and parallel independent work')
finally:
 release_followup.set()
 for client in clients: client.close()
 server.shutdown()
 server.server_close()
 temp_dir.cleanup()
