import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1] / 'ai-client'
SCRIPT = ROOT / 'monitorctl.py'
spec = importlib.util.spec_from_file_location('monitorctl', SCRIPT)
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
TOKEN = 'cm_ai_' + 'A' * 43
JOB = '12345678-1234-4234-8234-123456789abc'


class Handler(BaseHTTPRequestHandler):
    posts = []
    auth = []
    mode = 'manual'
    status = 'pending'
    source = None
    fail = False
    redirect = False
    def log_message(self, *args):
        pass
    def send(self, value, status=200):
        raw = json.dumps(value, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)
    def row(self):
        return dict(id=JOB, server_id='server_1', command='hostname', timeout_seconds=30, mode=self.mode, status=self.status,
                    stdout='测试主机', stderr='', exit_code=0, owner='private-user',
                    approved_source=self.source, grant_id='private-grant', approved_by='private-approver' if self.mode == 'manual' and self.status != 'pending' else None)
    def do_GET(self):
        self.auth.append(self.headers.get('Authorization'))
        Handler.user_agent = self.headers.get('User-Agent')
        if self.redirect:
            self.send_response(302)
            self.send_header('Location', 'https://example.invalid/')
            self.end_headers()
        elif self.path.endswith('/servers'):
            self.send([dict(id='server_1', name='测试主机', platform='win32',
                            commands_available=True, private_ipv4='192.168.0.2', secret='hidden')])
        elif '/servers/server_1/history?' in self.path:
            self.send({'server_id':'server_1','days':365,'points':[{'metrics':{'cpu_percent':12}}]})
        elif self.path.endswith('/servers/server_1'):
            self.send({'id':'server_1','metrics':{'cpu_percent':12},'volumes':[{'mount':'D:'}]})
        else:
            self.send(self.row())
    def do_POST(self):
        self.auth.append(self.headers.get('Authorization'))
        Handler.user_agent = self.headers.get('User-Agent')
        body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        self.posts.append((self.path, body))
        if self.path.endswith('/confirm'):
            Handler.status = {'approve':'dispatching','reject':'rejected','defer':'pending'}[body['decision']]
            Handler.source = 'client' if body['decision'] == 'approve' else None
        if self.fail:
            self.send({'error': 'Do not leak ' + TOKEN}, 503)
        else:
            self.send(self.row(), 202)


class Tests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join()
    def setUp(self):
        Handler.posts, Handler.auth = [], []
        Handler.fail, Handler.redirect = False, False
        Handler.mode, Handler.status = 'manual', 'pending'
        Handler.source = None
        self.client = m.Client(f'http://127.0.0.1:{self.server.server_port}', TOKEN, allow_loopback_http=True)
    def test_url_validation(self):
        self.assertEqual(m.api_base('https://example.com/'), 'https://example.com/api/ai/v1')
        for url in ['http://example.com', 'https://u:p@example.com', 'https://example.com/x',
                    'https://example.com/?token=x']:
            with self.assertRaises(m.ClientError):
                m.api_base(url)
    def test_credential_roundtrip(self):
        with tempfile.TemporaryDirectory() as folder:
            p = Path(folder) / '.secrets/client.json'
            m.save_config(p, 'https://example.com', TOKEN)
            self.assertEqual(m.load_config(p), ('https://example.com/api/ai/v1', TOKEN))
            if os.name == 'nt':
                self.assertNotIn(TOKEN, p.read_text())
                self.assertEqual(json.loads(p.read_text())['token_storage'], 'windows-dpapi')
            else:
                self.assertEqual(p.stat().st_mode & 0o777, 0o600)
    def test_server_metadata_filter(self):
        result = self.client.servers()
        self.assertTrue(result['servers'][0]['commands_available'])
        self.assertNotIn('secret', result['servers'][0])
        self.assertEqual(Handler.auth, ['Bearer ' + TOKEN])
        self.assertIn('ServerObserverAI/2.2.0', Handler.user_agent)
    def test_manual_submit_no_approval(self):
        result = self.client.submit('server_1', '$env:COMPUTERNAME', 'check-001')
        self.assertEqual(result['status'], 'pending')
        self.assertEqual(set(Handler.posts[0][1]), {'server_id', 'command', 'request_id', 'timeout_seconds'})
        self.assertEqual(len(Handler.posts), 1)
        for private in ['owner', 'approved_by', 'grant_id']:
            self.assertNotIn(private, result)
    def test_monitoring_reads_without_commands(self):
        self.assertEqual(self.client.server_status('server_1')['volumes'][0]['mount'], 'D:')
        self.assertEqual(self.client.metric_history('server_1',365)['points'][0]['metrics']['cpu_percent'],12)
        for days in [0,366,True,'30']:
            with self.assertRaises(m.ClientError): self.client.metric_history('server_1',days)
        self.assertEqual(Handler.posts, [])
    def test_auto_and_get_cancel(self):
        Handler.mode, Handler.status = 'auto', 'succeeded'
        result = self.client.submit('server_1', 'hostname', 'check-002')
        self.assertEqual(result['approval_status'], 'not_required')
        self.assertEqual(self.client.get(JOB)['exit_code'], 0)
        self.client.cancel(JOB)
        self.assertEqual(Handler.posts[-1], ('/api/ai/v1/commands/' + JOB + '/cancel', {}))
    def test_http_failure_no_retry_or_token_leak(self):
        Handler.fail = True
        with self.assertRaises(m.ClientError) as raised:
            self.client.submit('server_1', 'hostname', 'do-not-replay')
        self.assertEqual(len(Handler.posts), 1)
        self.assertEqual(raised.exception.request_id, 'do-not-replay')
        self.assertNotIn(TOKEN, str(raised.exception))
        self.assertEqual(raised.exception.status, 503)
    def test_redirect_rejected(self):
        Handler.redirect = True
        with self.assertRaises(m.ClientError) as raised:
            self.client.servers()
        self.assertEqual(raised.exception.status, 302)
    def test_input_limits(self):
        for timeout in [0, 301, True, '30']:
            with self.assertRaises(m.ClientError):
                self.client.submit('server_1', 'hostname', 'x', timeout)
        with self.assertRaises(m.ClientError):
            self.client.submit('server_1', '中' * 6000, 'x')
        self.assertEqual(Handler.posts, [])
    def test_mcp_handshake_tools_and_calls(self):
        requests = [
            dict(jsonrpc='2.0', id=1, method='initialize', params={'protocolVersion':'2025-11-25', 'capabilities':{}, 'clientInfo':{'name':'test','version':'1'}}),
            dict(jsonrpc='2.0', method='notifications/initialized'),
            dict(jsonrpc='2.0', id=2, method='tools/list'),
            dict(jsonrpc='2.0', id=3, method='tools/call', params={'name':'list_authorized_servers','arguments':{}}),
            dict(jsonrpc='2.0', id=4, method='tools/call', params={'name':'submit_server_command','arguments':{'server_id':'server_1','command':'hostname','request_id':'mcp-001'}}),
            dict(jsonrpc='2.0', id=5, method='tools/call', params={'name':'submit_server_command','arguments':{'server_id':'server_1','command':'hostname','request_id':'mcp-002','mode':'auto'}}),
            dict(jsonrpc='2.0', id=6, method='tools/call', params={'name':'get_server_command','arguments':{'command_id':JOB}}),
            dict(jsonrpc='2.0', id=7, method='tools/call', params={'name':'cancel_server_command','arguments':{'command_id':JOB}}),
        ]
        source = io.StringIO(''.join(json.dumps(row)+'\n' for row in requests))
        out = io.StringIO()
        with patch.object(m.sys, 'stdin', source), contextlib.redirect_stdout(out):
            m.serve_mcp(lambda: self.client, local_confirmer=lambda job,server: False)
        replies = [json.loads(line) for line in out.getvalue().splitlines()]
        self.assertEqual(len(replies), 7)
        self.assertEqual(len(replies[1]['result']['tools']), 6)
        self.assertTrue(replies[4]['result']['isError'])
        self.assertEqual(len(Handler.posts), 3)
        self.assertNotIn(TOKEN, out.getvalue())
    def test_mcp_without_credentials_initializes(self):
        lines = [dict(jsonrpc='2.0', id=1, method='initialize', params={}),
                 dict(jsonrpc='2.0', method='notifications/initialized'),
                 dict(jsonrpc='2.0', id=2, method='tools/call', params={'name':'list_authorized_servers'})]
        out = io.StringIO()
        def missing():
            raise m.ClientError('configure first')
        with patch.object(m.sys, 'stdin', io.StringIO(''.join(json.dumps(x)+'\n' for x in lines))), contextlib.redirect_stdout(out):
            m.serve_mcp(missing)
        self.assertTrue(json.loads(out.getvalue().splitlines()[-1])['result']['isError'])

    def test_mcp_native_confirmation_approves_exactly_one_job(self):
        for action, content, expected in [('accept',{'confirm':True},'approve'),('accept',{'confirm':False},'defer'),('decline',{},'defer'),('cancel',{},'defer')]:
            with self.subTest(action=action,content=content):
                Handler.posts=[];Handler.status='pending';Handler.source=None
                fixed='00000000-0000-4000-8000-000000000001'
                lines=[dict(jsonrpc='2.0',id=1,method='initialize',params={'protocolVersion':'2025-11-25','capabilities':{'elicitation':{'form':{}}},'clientInfo':{'name':'Codex-test','version':'1'}}),
                    dict(jsonrpc='2.0',method='notifications/initialized'),
                    dict(jsonrpc='2.0',id=2,method='tools/call',params={'name':'submit_server_command','arguments':{'server_id':'server_1','command':'hostname','request_id':'native-001'}}),
                    dict(jsonrpc='2.0',id='confirm-'+fixed,result={'action':action,'content':content})]
                out=io.StringIO()
                with patch.object(m.sys,'stdin',io.StringIO(''.join(json.dumps(x)+'\n' for x in lines))), contextlib.redirect_stdout(out), patch.object(m.uuid,'uuid4',return_value=fixed):
                    m.serve_mcp(lambda:self.client,confirmation_mode='native',local_confirmer=lambda *_:self.fail('Native form should be used'))
                replies=[json.loads(x) for x in out.getvalue().splitlines()]
                self.assertEqual(replies[1]['method'],'elicitation/create')
                self.assertIn('hostname',replies[1]['params']['message'])
                self.assertFalse(replies[1]['params']['requestedSchema']['properties']['confirm']['default'])
                self.assertEqual(Handler.posts[-1][1]['decision'],expected)
                self.assertEqual(len(Handler.posts),2)
                self.assertEqual(Handler.posts[-1][1]['client_name'],'Codex-test')
                value=json.loads(replies[-1]['result']['content'][0]['text'])
                if expected=='approve':
                    self.assertTrue(value['client_confirmed']);self.assertFalse(value['human_approved'])

    def test_missing_client_approval_response_never_approves(self):
        lines=[dict(jsonrpc='2.0',id=1,method='initialize',params={'capabilities':{'elicitation':{}}}),
            dict(jsonrpc='2.0',method='notifications/initialized'),
            dict(jsonrpc='2.0',id=2,method='tools/call',params={'name':'submit_server_command','arguments':{'server_id':'server_1','command':'hostname','request_id':'interrupted-001'}})]
        with patch.object(m.sys,'stdin',io.StringIO(''.join(json.dumps(x)+'\n' for x in lines))), contextlib.redirect_stdout(io.StringIO()):
            m.serve_mcp(lambda:self.client,confirmation_mode='native')
        self.assertEqual(Handler.posts[-1][1]['decision'],'defer')


    def mcp_lines(self, protocol='2025-11-25', caps=None):
        return [dict(jsonrpc='2.0',id=1,method='initialize',params={'protocolVersion':protocol,'capabilities':caps or {},'clientInfo':{'name':'OtherAIClient','version':'test'}}),
            dict(jsonrpc='2.0',method='notifications/initialized'),
            dict(jsonrpc='2.0',id=2,method='tools/call',params={'name':'submit_server_command','arguments':{'server_id':'server_1','command':'hostname','request_id':'compat-001'}})]

    def test_multiple_protocol_versions_and_local_question_default(self):
        for protocol in ['2024-11-05','2025-03-26','2025-06-18','2025-11-25']:
            with self.subTest(protocol=protocol):
                Handler.posts=[];Handler.status='pending'
                lines=self.mcp_lines(protocol,{'elicitation':{'form':{}}})
                out=io.StringIO();calls=[]
                def question(job,server):
                    calls.append((job,server));return m.Confirmation('approved','local_gui','human_approved','test-only injected human answer')
                with patch.object(m.sys,'stdin',io.StringIO(''.join(json.dumps(x)+'\n' for x in lines))),contextlib.redirect_stdout(out):
                    m.serve_mcp(lambda:self.client,local_confirmer=question)
                replies=[json.loads(x) for x in out.getvalue().splitlines()]
                self.assertEqual(replies[0]['result']['protocolVersion'],protocol)
                self.assertEqual(len(calls),1)
                self.assertFalse(any(x.get('method')=='elicitation/create' for x in replies))
                self.assertEqual(Handler.posts[-1][1]['decision'],'approve')
                self.assertEqual(Handler.posts[-1][1]['client_name'],'OtherAIClient')

    def test_native_protocol_error_stays_pending(self):
        fixed='00000000-0000-4000-8000-000000000001'
        lines=self.mcp_lines(caps={'elicitation':{'form':{}}})+[dict(jsonrpc='2.0',id='confirm-'+fixed,error={'code':-32601,'message':'unsupported '+TOKEN})]
        out=io.StringIO()
        with patch.object(m.sys,'stdin',io.StringIO(''.join(json.dumps(x)+'\n' for x in lines))),contextlib.redirect_stdout(out),patch.object(m.uuid,'uuid4',return_value=fixed):
            m.serve_mcp(lambda:self.client,confirmation_mode='native')
        value=json.loads(json.loads(out.getvalue().splitlines()[-1])['result']['content'][0]['text'])
        self.assertEqual(value['status'],'pending')
        self.assertEqual(value['confirmation']['reason_code'],'native_protocol_error')
        self.assertNotIn(TOKEN,out.getvalue())
        self.assertNotIn(TOKEN,json.dumps(Handler.posts))

    def test_no_native_capability_preserves_pending(self):
        out=io.StringIO()
        with patch.object(m.sys,'stdin',io.StringIO(''.join(json.dumps(x)+'\n' for x in self.mcp_lines()))),contextlib.redirect_stdout(out):
            m.serve_mcp(lambda:self.client,confirmation_mode='native')
        self.assertEqual(Handler.posts[-1][1]['decision'],'defer')
        self.assertEqual(Handler.posts[-1][1]['confirmation']['reason_code'],'native_capability_missing')

    def test_explicit_reject_and_errors_are_distinct(self):
        job=self.client.submit('server_1','hostname','outcomes-001')
        for state,decision in [('error','defer'),('timeout','defer'),('unavailable','defer'),('cancelled','defer'),('rejected','reject')]:
            Handler.status='pending'
            outcome=m.Confirmation(state,'test','test-'+state,'test')
            result=m.settle_confirmation(self.client,job,outcome,'GenericClient','1')
            self.assertEqual(Handler.posts[-1][1]['decision'],decision)
            self.assertEqual(result['status'],'rejected' if state=='rejected' else 'pending')

    def test_confirmation_report_failure_does_not_invent_a_rejection(self):
        job=self.client.submit('server_1','hostname','failed-report')
        Handler.fail=True
        result=m.settle_confirmation(self.client,job,m.Confirmation('unavailable','test','no_ui','no UI'),'test','1')
        self.assertEqual(result['status'],'pending')
        self.assertEqual(result['confirmation_reporting_error']['command_id'],JOB)
        self.assertNotIn(TOKEN,json.dumps(result))
        with self.assertRaises(m.ClientError) as raised:
            m.settle_confirmation(self.client,job,m.Confirmation('approved','test','yes','yes'),'test','1')
        self.assertEqual(raised.exception.command_id,JOB)

    @unittest.skipUnless(os.name=='nt','Windows local GUI process contract')
    def test_local_gui_error_and_cancel_are_pending_outcomes(self):
        job={'id':JOB,'server_id':'server_1','command':'hostname'}
        from unittest.mock import MagicMock
        for reply,code,expected in [({'approved':True,'state':'approved'},0,'approved'),({'approved':False,'state':'rejected'},0,'rejected'),({'approved':False,'state':'cancelled'},0,'cancelled'),({},1,'error'),([],0,'error')]:
            proc=MagicMock();proc.poll.return_value=code;proc.returncode=code
            proc.communicate.return_value=(json.dumps(reply),'test error')
            with patch.object(m.subprocess,'Popen',return_value=proc):
                result=m.local_confirmation(job,{'id':'server_1'})
            self.assertEqual(result.state,expected)
        proc=MagicMock();proc.poll.return_value=None;proc.communicate.return_value=('','')
        with patch.object(m.subprocess,'Popen',return_value=proc),patch.object(m.time,'monotonic',side_effect=[0,601]):
            self.assertEqual(m.local_confirmation(job,{}).state,'timeout')
        with patch.object(m.subprocess,'Popen',return_value=proc):
            self.assertEqual(m.local_confirmation(job,{},cancel_check=lambda:True).state,'cancelled')

    def test_native_timeout_is_not_an_approval(self):
        def expired():
            raise TimeoutError('test')
            yield ''
        with contextlib.redirect_stdout(io.StringIO()):
            with self.assertRaises(TimeoutError):
                m.mcp_confirmation({'id':JOB,'server_id':'server_1','command':'hostname'},{},1,'2025-11-25',expired())


if __name__ == '__main__':
    unittest.main(verbosity=2)
