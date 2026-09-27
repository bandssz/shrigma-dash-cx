import concurrent.futures
from email.message import EmailMessage
import smtplib
import socket
import time
import unittest
from unittest.mock import patch

from smtp_capture import CaptureSMTP, MAX_COMMANDS, MAX_MESSAGES, MAX_MESSAGE_BYTES


def message(subject='CONTROL'):
    mail = EmailMessage()
    mail['From'] = 'smoke@example.invalid'
    mail['To'] = 's001@example.invalid'
    mail['Subject'] = subject
    mail.set_content('Synthetic body\n.dot-stuffed line\n')
    mail.add_alternative('<p>Fixture <a href="https://example.invalid/item">link</a></p>', subtype='html')
    return mail


class CaptureTests(unittest.TestCase):
    def test_loopback_capture_decodes_mime_and_returns_detached_snapshots(self):
        with CaptureSMTP() as capture:
            self.assertEqual(capture._server.server_address[0], '127.0.0.1')
            self.assertGreater(capture.port, 0)
            with smtplib.SMTP('127.0.0.1', capture.port, timeout=2) as client:
                self.assertEqual(client.ehlo()[0], 250)
                self.assertEqual(client.esmtp_features['size'], str(MAX_MESSAGE_BYTES))
                self.assertEqual(client.noop()[0], 250)
                self.assertEqual(client.rset()[0], 250)
                self.assertEqual(client.send_message(message('AB-A · sintético')), {})
            rows = capture.messages
            self.assertEqual(len(rows), 1)
            self.assertEqual(set(rows[0]), {'sender', 'recipients', 'subject', 'body'})
            self.assertEqual(rows[0]['sender'], 'smoke@example.invalid')
            self.assertEqual(rows[0]['recipients'], ['s001@example.invalid'])
            self.assertEqual(rows[0]['subject'], 'AB-A · sintético')
            self.assertIn('.dot-stuffed line', rows[0]['body'])
            self.assertIn('https://example.invalid/item', rows[0]['body'])
            rows[0]['recipients'].append('not-saved@example.invalid')
            rows[0]['body'] = 'changed snapshot'
            self.assertEqual(capture.messages[0]['recipients'], ['s001@example.invalid'])
            self.assertNotEqual(capture.messages[0]['body'], 'changed snapshot')
            self.assertEqual(capture.errors, [])

    def test_external_sender_and_recipient_are_refused_without_capture(self):
        for sender, recipient, expected in [
            ('smoke@outside.invalid', 's001@example.invalid', smtplib.SMTPSenderRefused),
            ('smoke@example.invalid', 's001@outside.invalid', smtplib.SMTPRecipientsRefused),
            ('smoke@example.invalid', 's001@example.invalid.evil.invalid', smtplib.SMTPRecipientsRefused),
        ]:
            with self.subTest(sender=sender, recipient=recipient), CaptureSMTP() as capture:
                with smtplib.SMTP('127.0.0.1', capture.port, timeout=2) as client:
                    with self.assertRaises(expected):
                        client.sendmail(sender, [recipient], 'Subject: CONTROL\r\n\r\nSynthetic')
                self.assertEqual(capture.messages, [])
                self.assertEqual(len(capture.errors), 1)
                self.assertNotIn('@', capture.errors[0])

    def test_second_recipient_invalidates_the_transaction(self):
        with CaptureSMTP() as capture, smtplib.SMTP('127.0.0.1', capture.port, timeout=2) as client:
            self.assertEqual(client.helo()[0], 250)
            self.assertEqual(client.mail('smoke@example.invalid')[0], 250)
            self.assertEqual(client.rcpt('s001@example.invalid')[0], 250)
            self.assertEqual(client.rcpt('s002@example.invalid')[0], 452)
            with self.assertRaises(smtplib.SMTPDataError):
                client.data('Subject: CONTROL\r\n\r\nNo partial delivery')
            self.assertEqual(capture.messages, [])
            self.assertIn('recipient_limit', capture.errors)
            self.assertEqual(client.rset()[0], 250)
            self.assertEqual(client.sendmail('smoke@example.invalid', ['s003@example.invalid'],
                                             'Subject: CONTROL\r\n\r\nNew transaction'), {})
            self.assertEqual(capture.messages[0]['recipients'], ['s003@example.invalid'])

    def test_declared_and_actual_oversize_messages_are_refused(self):
        with CaptureSMTP() as capture:
            client = smtplib.SMTP('127.0.0.1', capture.port, timeout=2)
            try:
                client.ehlo()
                self.assertEqual(client.mail('smoke@example.invalid', ['SIZE=%d' % (MAX_MESSAGE_BYTES + 1)])[0], 552)
                self.assertEqual(client.mail('smoke@example.invalid')[0], 250)
                self.assertEqual(client.rcpt('s001@example.invalid')[0], 250)
                code, _ = client.data('Subject: CONTROL\r\n\r\n' + 'x' * (MAX_MESSAGE_BYTES + 1))
                self.assertEqual(code, 552)
            finally:
                client.close()
            self.assertEqual(capture.messages, [])
            self.assertEqual(capture.errors, ['message_size', 'message_size'])

    def test_message_and_command_caps_are_enforced(self):
        with CaptureSMTP() as capture, smtplib.SMTP('127.0.0.1', capture.port, timeout=2) as client:
            for i in range(MAX_MESSAGES):
                client.sendmail('smoke@example.invalid', ['s001@example.invalid'],
                                'Subject: CONTROL-%d\r\n\r\nSynthetic' % i)
            with self.assertRaises(smtplib.SMTPSenderRefused) as caught:
                client.sendmail('smoke@example.invalid', ['s001@example.invalid'], 'Subject: OVER\r\n\r\nNo capture')
            self.assertEqual(caught.exception.smtp_code, 452)
            self.assertEqual(len(capture.messages), MAX_MESSAGES)
            self.assertEqual(capture.errors, ['message_limit'])
        with CaptureSMTP() as capture:
            client = smtplib.SMTP('127.0.0.1', capture.port, timeout=2)
            try:
                for _ in range(MAX_COMMANDS):
                    self.assertEqual(client.noop()[0], 250)
                self.assertEqual(client.noop()[0], 421)
            finally:
                client.close()
            self.assertEqual(capture.errors, ['command_limit'])

    def test_parallel_captures_have_no_cross_transaction_state(self):
        with CaptureSMTP() as capture:
            def send(i):
                with smtplib.SMTP('127.0.0.1', capture.port, timeout=2) as client:
                    client.sendmail('smoke@example.invalid', ['s%03d@example.invalid' % i],
                                    'Subject: AB-%d\r\n\r\nFixture-%d' % (i, i))
            with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
                list(pool.map(send, range(1, 9)))
            self.assertEqual(len(capture.messages), 8)
            for row in capture.messages:
                number = int(row['subject'].split('-')[1])
                self.assertEqual(row['recipients'], ['s%03d@example.invalid' % number])
                self.assertIn('Fixture-%d' % number, row['body'])
            self.assertEqual(capture.errors, [])

    def test_exit_closes_listener_and_idle_threads_without_errors(self):
        capture = CaptureSMTP()
        with capture:
            client = smtplib.SMTP('127.0.0.1', capture.port, timeout=2)
            client.helo()
            thread = capture._thread
            port = capture.port
            started = time.monotonic()
        try:
            self.assertLess(time.monotonic() - started, 2)
            self.assertFalse(thread.is_alive())
            with self.assertRaises(OSError):
                socket.create_connection(('127.0.0.1', port), timeout=0.2)
            self.assertEqual(capture.errors, [])
            with self.assertRaises(RuntimeError):
                capture.__enter__()
        finally:
            client.close()

    def test_partial_data_timeout_is_recorded_without_capturing(self):
        with patch('smtp_capture.SOCKET_TIMEOUT', 0.1), CaptureSMTP() as capture:
            with socket.create_connection(('127.0.0.1', capture.port), timeout=2) as client:
                stream = client.makefile('rb')
                try:
                    self.assertTrue(stream.readline().startswith(b'220'))
                    for command, code in [('HELO example.invalid', b'250'),
                                          ('MAIL FROM:<smoke@example.invalid>', b'250'),
                                          ('RCPT TO:<s001@example.invalid>', b'250'), ('DATA', b'354')]:
                        client.sendall(command.encode() + b'\r\n')
                        self.assertTrue(stream.readline().startswith(code))
                    client.sendall(b'Subject: CONTROL\r\n')
                    self.assertEqual(stream.readline(), b'')
                finally:
                    stream.close()
            self.assertEqual(capture.messages, [])
            self.assertEqual(capture.errors, ['data_timeout'])

    def test_invalid_ports_and_unsupported_commands_are_refused(self):
        for port in (-1, 65536, True, '25'):
            with self.assertRaises(ValueError):
                CaptureSMTP(port)
        with CaptureSMTP() as capture, smtplib.SMTP('127.0.0.1', capture.port, timeout=2) as client:
            self.assertEqual(client.docmd('VRFY', 's001@example.invalid')[0], 502)
            self.assertEqual(client.docmd('AUTH', 'PLAIN ignored')[0], 502)
            self.assertEqual(capture.errors, ['command', 'command'])
            errors = capture.errors
            errors.clear()
            self.assertEqual(capture.errors, ['command', 'command'])


if __name__ == '__main__':
    unittest.main()
