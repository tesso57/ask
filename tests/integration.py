import json, os, subprocess, tempfile, select, time, threading
from pathlib import Path
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
requests = []
hold_followup = False
parallel_case = False
many_case = False
invalid_case = False
unsafe_case = False
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
      args = json.dumps({'question': 'Pick one\x1b]52;c;SGVsbG8=\x07' if unsafe_case else 'Pick one', 'options': ['A', ' A '] if invalid_case else ['A', 'B'], 'mode': 'async'})
      tools = [{'index': 0, 'id': 'call_1', 'type': 'function', 'function': {'name': 'ask_user', 'arguments': args}}]
      if many_case:
        tools = [{'index': i, 'id': f'call_{i}', 'type': 'function', 'function': {'name': 'ask_user', 'arguments': json.dumps({'question': f'Question {i + 1}?', 'options': ['A', 'B'], 'mode': 'async'})}} for i in range(13)]
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
 c.send({'id':'answer','type':'prompt','message':'/answer'})
 req=c.until(lambda x:x.get('method')=='select')
 assert req['title'] == '回答する質問を選択' and any('#1 Pick one' in option for option in req['options']), req
 c.send({'type':'extension_ui_response','id':req['id'],'value':req['options'][0]})
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
 c.send({'id':'answer-stream','type':'prompt','message':'/answer','streamingBehavior':'steer'})
 req=c.until(lambda x:x.get('method')=='select')
 assert req['title'] == '回答する質問を選択', req
 c.send({'type':'extension_ui_response','id':req['id'],'value':req['options'][0]})
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
 # Dismissing informs the model that no answer or approval was given.
 requests.clear(); parallel_case = False; session = tmp + '/dismiss.jsonl'
 c=Client(); c.send({'id':'dismiss-init','type':'prompt','message':'hello'})
 c.until(lambda x:x.get('type')=='agent_settled')
 c.send({'id':'dismiss','type':'prompt','message':'/ask-dismiss 1'})
 c.until(lambda x:x.get('type')=='message_start' and x.get('message',{}).get('role')=='user' and '取り下げ' in json.dumps(x.get('message',{}), ensure_ascii=False))
 c.until(lambda x:x.get('type')=='agent_settled'); c.close()
 assert any(message.get('role') == 'user' and '未回答' in json.dumps(message.get('content'), ensure_ascii=False) and '承認' in json.dumps(message.get('content'), ensure_ascii=False) for req in requests for message in req.get('messages', [])), requests
 c=Client(); c.send({'id':'dismiss-check','type':'prompt','message':'/answer 1'})
 notice=c.until(lambda x:x.get('method')=='notify')
 assert 'ありません' in notice.get('message',''), notice
 c.close()
 # Invalid options return a tool error without creating a pending question.
 requests.clear(); invalid_case = True; session = tmp + '/invalid.jsonl'
 c=Client(); c.send({'id':'invalid','type':'prompt','message':'hello'})
 c.until(lambda x:x.get('type')=='agent_settled')
 assert any(e.get('type') == 'tool_execution_end' and e.get('toolName') == 'ask_user' and e.get('isError') for e in c.events), c.events
 assert not any(e.get('method') == 'setWidget' and e.get('widgetLines') for e in c.events), c.events
 c.close()
 # Terminal controls in model-generated text are rejected before UI display.
 requests.clear(); invalid_case = False; unsafe_case = True; session = tmp + '/unsafe.jsonl'
 c=Client(); c.send({'id':'unsafe','type':'prompt','message':'hello'})
 c.until(lambda x:x.get('type')=='agent_settled')
 assert any(e.get('type') == 'tool_execution_end' and e.get('toolName') == 'ask_user' and e.get('isError') for e in c.events), c.events
 assert not any('\x1b' in (e.get('message') or '') or any('\x1b' in line for line in (e.get('widgetLines') or [])) for e in c.events if e.get('type') == 'extension_ui_request'), c.events
 c.close()
 # An answer dialog waiting in the old session must not block replacement or submit late.
 requests.clear(); unsafe_case = False; session = tmp + '/switch-dialog.jsonl'
 c=Client(); c.send({'id':'switch-init','type':'prompt','message':'hello'})
 c.until(lambda x:x.get('type')=='agent_settled')
 c.send({'id':'old-answer','type':'prompt','message':'/answer 1'})
 old_dialog=c.until(lambda x:x.get('method')=='select')
 c.send({'id':'new-session','type':'new_session'})
 c.until(lambda x: all(any(e.get('id') == key and e.get('type') == 'response' and e.get('success') for e in c.events) for key in ('old-answer', 'new-session')))
 c.send({'type':'extension_ui_response','id':old_dialog['id'],'value':'1. A'})
 c.send({'id':'state-after-switch','type':'get_state'})
 c.until(lambda x:x.get('type')=='response' and x.get('id')=='state-after-switch' and x.get('success'))
 assert not any(message.get('role') == 'user' and '質問 #1' in json.dumps(message.get('content'), ensure_ascii=False) for req in requests for message in req.get('messages', [])), requests
 c.close()
 # A dismissal received while an answer dialog is open releases that dialog.
 requests.clear(); session = tmp + '/dismiss-open.jsonl'
 c=Client(); c.send({'id':'dismiss-open-init','type':'prompt','message':'hello'})
 c.until(lambda x:x.get('type')=='agent_settled')
 c.send({'id':'open-answer','type':'prompt','message':'/answer 1'})
 old_dialog=c.until(lambda x:x.get('method')=='select')
 start=len(c.events)
 c.send({'id':'dismiss-open','type':'prompt','message':'/ask-dismiss 1'})
 c.until(lambda x: all(any(e.get('id') == key and e.get('type') == 'response' and e.get('success') for e in c.events[start:]) for key in ('open-answer', 'dismiss-open')) and any(e.get('type') == 'agent_settled' for e in c.events[start:]))
 c.send({'type':'extension_ui_response','id':old_dialog['id'],'value':'1. A'})
 c.send({'id':'state-after-dismiss','type':'get_state'})
 c.until(lambda x:x.get('type')=='response' and x.get('id')=='state-after-dismiss' and x.get('success'))
 assert not any(message.get('role') == 'user' and 'への回答:' in json.dumps(message.get('content'), ensure_ascii=False) for req in requests for message in req.get('messages', [])), requests
 c.close()
 # The question picker remains navigable when many questions are pending.
 requests.clear(); many_case = True; session = tmp + '/many.jsonl'
 c=Client(); c.send({'id':'many-init','type':'prompt','message':'hello'})
 c.until(lambda x:x.get('type')=='agent_settled')
 c.send({'id':'many-answer','type':'prompt','message':'/answer'})
 for page in range(3):
  req=c.until(lambda x:x.get('method')=='select')
  assert len(req['options']) <= 7, req
  selected=next(option for option in req['options'] if ('次へ' in option if page < 2 else option.startswith('#13 ')))
  c.send({'type':'extension_ui_response','id':req['id'],'value':selected})
 req=c.until(lambda x:x.get('method')=='select')
 assert req['title'] == 'Question 13?', req
 c.send({'type':'extension_ui_response','id':req['id'],'value':'1. A'})
 c.until(lambda x:x.get('type')=='agent_settled')
 assert any(message.get('role') == 'user' and '#13' in json.dumps(message.get('content'), ensure_ascii=False) for req in requests for message in req.get('messages', [])), requests
 c.close()
 # A picker refreshed after a concurrent dismissal remains usable.
 requests.clear(); session = tmp + '/stale-picker.jsonl'
 c=Client(); c.send({'id':'stale-init','type':'prompt','message':'hello'})
 c.until(lambda x:x.get('type')=='agent_settled')
 c.send({'id':'stale-answer','type':'prompt','message':'/answer'})
 stale=c.until(lambda x:x.get('method')=='select')
 stale_choice=next(option for option in stale['options'] if option.startswith('#1 '))
 c.send({'id':'stale-dismiss','type':'prompt','message':'/ask-dismiss 1'})
 c.until(lambda x:x.get('type')=='agent_settled')
 c.send({'type':'extension_ui_response','id':stale['id'],'value':stale_choice})
 refreshed=c.until(lambda x:x.get('method')=='select')
 assert not any(option.startswith('#1 ') for option in refreshed['options']), refreshed
 selected=next(option for option in refreshed['options'] if option.startswith('#2 '))
 c.send({'type':'extension_ui_response','id':refreshed['id'],'value':selected})
 req=c.until(lambda x:x.get('method')=='select')
 assert req['title']=='Question 2?', req
 c.send({'type':'extension_ui_response','id':req['id'],'value':'1. A'})
 c.until(lambda x:x.get('type')=='agent_settled')
 assert any(message.get('role') == 'user' and '#2' in json.dumps(message.get('content'), ensure_ascii=False) and '回答' in json.dumps(message.get('content'), ensure_ascii=False) for req in requests for message in req.get('messages', [])), requests
 c.close()
 print('Pi RPC: restoration, answers, pagination, dismissal, switching, parallel work, and invalid inputs')
finally:
 release_followup.set()
 for client in clients: client.close()
 server.shutdown()
 server.server_close()
 temp_dir.cleanup()
