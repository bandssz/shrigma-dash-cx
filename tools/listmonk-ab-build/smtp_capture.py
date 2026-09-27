"""Bounded loopback-only SMTP sink for synthetic CI messages. Never relays mail."""
import copy
from email import policy
from email.parser import BytesParser
import re
import socket
import socketserver
import threading

MAX_MESSAGES = 128
MAX_MESSAGE_BYTES = 64 * 1024
MAX_COMMANDS = 512
MAX_COMMAND_BYTES = 512
MAX_CONNECTIONS = 8
SOCKET_TIMEOUT = 10
ADDRESS = re.compile(r"[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@example\.invalid", re.I)


class _Server(socketserver.ThreadingMixIn, socketserver.TCPServer):
    allow_reuse_address = True
    daemon_threads = False
    block_on_close = True

    def __init__(self, capture, port):
        self.capture = capture
        self.stopping = threading.Event()
        self.slots = threading.BoundedSemaphore(MAX_CONNECTIONS)
        self.active = set()
        self.active_lock = threading.Lock()
        super().__init__(('127.0.0.1', port), _Handler)

    def process_request(self, request, client_address):
        if self.stopping.is_set():
            self.shutdown_request(request)
            return
        if not self.slots.acquire(blocking=False):
            self.capture._error('connection_limit')
            try:
                request.settimeout(SOCKET_TIMEOUT)
                request.sendall(b'421 Too many local connections\r\n')
            except OSError:
                pass
            self.shutdown_request(request)
            return
        with self.active_lock:
            self.active.add(request)
        try:
            super().process_request(request, client_address)
        except Exception:
            with self.active_lock:
                self.active.discard(request)
            self.slots.release()
            self.shutdown_request(request)
            raise

    def process_request_thread(self, request, client_address):
        try:
            super().process_request_thread(request, client_address)
        finally:
            with self.active_lock:
                self.active.discard(request)
            self.slots.release()

    def handle_error(self, request, client_address):
        if not self.stopping.is_set():
            self.capture._error('handler_error')


class _Handler(socketserver.StreamRequestHandler):
    def setup(self):
        self.request.settimeout(SOCKET_TIMEOUT)
        super().setup()

    def reply(self, code, text):
        self.wfile.write(('%s %s\r\n' % (code, text)).encode('ascii'))

    def reset(self):
        self.sender = None
        self.recipients = []

    def reject(self, code, label, text):
        self.server.capture._error(label)
        self.reset()
        self.reply(code, text)

    def envelope(self, argument, command):
        prefix = 'FROM' if command == 'MAIL' else 'TO'
        match = re.fullmatch(prefix + r':\s*<([^<>]*)>(.*)', argument, re.I)
        if not match or not ADDRESS.fullmatch(match[1]) or len(match[1]) > 254:
            self.reject(553, command.lower() + '_address', 'Synthetic example.invalid address required')
            return None
        options = match[2].strip().split()
        if command == 'RCPT' and options:
            self.reject(555, 'rcpt_options', 'Recipient parameters are not supported')
            return None
        seen = set()
        for option in options:
            name, separator, value = option.upper().partition('=')
            if not separator or name in seen or name not in ('SIZE', 'BODY'):
                self.reject(555, 'mail_options', 'Unsupported sender parameters')
                return None
            seen.add(name)
            if name == 'SIZE':
                if not re.fullmatch(r'[0-9]{1,10}', value) or int(value) > MAX_MESSAGE_BYTES:
                    self.reject(552, 'message_size', 'Message exceeds local size limit')
                    return None
            elif value not in ('7BIT', '8BITMIME'):
                self.reject(555, 'mail_options', 'Unsupported body encoding')
                return None
        return match[1]

    def data(self):
        self.reply(354, 'End with a line containing only a dot')
        self.in_data = True
        raw = bytearray()
        while not self.server.stopping.is_set():
            line = self.rfile.readline(MAX_MESSAGE_BYTES + 3)
            if not line:
                self.server.capture._error('data_eof')
                return False
            if line == b'.\r\n':
                self.in_data = False
                if self.server.capture._record(self.sender, self.recipients, bytes(raw)):
                    self.reply(250, 'Captured locally')
                else:
                    self.reject(452, 'message_limit', 'Local message capacity reached')
                self.reset()
                return True
            if line.startswith(b'.'):
                line = line[1:]
            if not line.endswith(b'\r\n') or len(raw) + len(line) > MAX_MESSAGE_BYTES:
                self.reject(552, 'message_size', 'Message exceeds local size limit or framing')
                return False
            raw.extend(line)
        return False

    def handle(self):
        self.reset()
        self.in_data = False
        greeted = False
        try:
            self.reply(220, 'example.invalid synthetic local capture')
            for _ in range(MAX_COMMANDS):
                if self.server.stopping.is_set():
                    return
                line = self.rfile.readline(MAX_COMMAND_BYTES + 1)
                if not line:
                    return
                if len(line) > MAX_COMMAND_BYTES or not line.endswith(b'\r\n'):
                    self.reject(500, 'command_size', 'Invalid command length or framing')
                    return
                try:
                    text = line[:-2].decode('ascii')
                except UnicodeDecodeError:
                    self.reject(500, 'command_encoding', 'ASCII SMTP commands required')
                    return
                if any(ord(c) < 32 or ord(c) == 127 for c in text):
                    self.reject(500, 'command_encoding', 'Control characters are not allowed')
                    return
                command, _, argument = text.partition(' ')
                command = command.upper()
                if command in ('EHLO', 'HELO'):
                    if not argument or ' ' in argument:
                        self.reject(501, 'greeting', 'Greeting name required')
                        continue
                    greeted = True
                    self.reset()
                    if command == 'EHLO':
                        self.wfile.write(b'250-example.invalid\r\n250-SIZE 65536\r\n250 8BITMIME\r\n')
                    else:
                        self.reply(250, 'example.invalid')
                elif command == 'QUIT' and not argument:
                    self.reply(221, 'Goodbye')
                    return
                elif command in ('RSET', 'NOOP') and (command == 'NOOP' or not argument):
                    if command == 'RSET':
                        self.reset()
                    self.reply(250, 'OK')
                elif command == 'MAIL':
                    self.reset()
                    if not greeted:
                        self.reject(503, 'sequence', 'Send EHLO or HELO first')
                    elif self.server.capture._full():
                        self.reject(452, 'message_limit', 'Local message capacity reached')
                    else:
                        self.sender = self.envelope(argument, 'MAIL')
                        if self.sender is not None:
                            self.reply(250, 'Sender accepted')
                elif command == 'RCPT':
                    if self.sender is None:
                        self.reject(503, 'sequence', 'Sender required first')
                    elif self.recipients:
                        self.reject(452, 'recipient_limit', 'One recipient per transaction required')
                    else:
                        recipient = self.envelope(argument, 'RCPT')
                        if recipient is not None:
                            self.recipients = [recipient]
                            self.reply(250, 'Recipient accepted')
                elif command == 'DATA' and not argument:
                    if self.sender is None or len(self.recipients) != 1:
                        self.reject(503, 'sequence', 'One accepted recipient required')
                    elif not self.data():
                        return
                else:
                    self.reject(502, 'command', 'Command not supported')
            self.reject(421, 'command_limit', 'Local command limit reached')
        except socket.timeout:
            if self.in_data and not self.server.stopping.is_set():
                self.server.capture._error('data_timeout')
        except OSError:
            if self.in_data and not self.server.stopping.is_set():
                self.server.capture._error('data_connection_closed')


class CaptureSMTP:
    """Context-managed, non-relaying local SMTP capture with detached snapshots."""

    def __init__(self, port=0):
        if isinstance(port, bool) or not isinstance(port, int) or not 0 <= port <= 65535:
            raise ValueError('Invalid local port')
        self.port = port
        self._messages = []
        self._errors = []
        self._lock = threading.Lock()
        self._server = None
        self._thread = None
        self._used = False

    @property
    def messages(self):
        with self._lock:
            return copy.deepcopy(self._messages)

    @property
    def errors(self):
        with self._lock:
            return list(self._errors)

    def _error(self, code):
        with self._lock:
            # Error payloads never contain addresses or message content.
            if len(self._errors) < MAX_COMMANDS:
                self._errors.append(code)

    def _full(self):
        with self._lock:
            return len(self._messages) >= MAX_MESSAGES

    def _record(self, sender, recipients, raw):
        message = BytesParser(policy=policy.default).parsebytes(raw)
        parts = []
        for part in message.walk():
            if part.is_multipart() or part.get_content_maintype() != 'text':
                continue
            payload = part.get_payload(decode=True) or b''
            try:
                parts.append(payload.decode(part.get_content_charset() or 'utf-8', errors='replace'))
            except LookupError:
                parts.append(payload.decode('utf-8', errors='replace'))
        row = {'sender': sender, 'recipients': list(recipients),
               'subject': str(message.get('Subject', '')), 'body': '\n'.join(parts)}
        with self._lock:
            if len(self._messages) >= MAX_MESSAGES:
                return False
            self._messages.append(row)
            return True

    def __enter__(self):
        if self._used:
            raise RuntimeError('Use a new SMTP capture for each context')
        self._used = True
        self._server = _Server(self, self.port)
        self.port = self._server.server_address[1]
        self._thread = threading.Thread(target=self._server.serve_forever,
                                        kwargs={'poll_interval': 0.05}, name='synthetic-smtp-capture')
        self._thread.start()
        return self

    def __exit__(self, exc_type, exc_value, traceback):
        self._server.stopping.set()
        self._server.shutdown()
        with self._server.active_lock:
            active = list(self._server.active)
        for connection in active:
            try:
                connection.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass
            connection.close()
        self._server.server_close()
        self._thread.join()
        return False
