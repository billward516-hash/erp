import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import tls from 'node:tls';

/**
 * A small SMTP server that runs inside the test process (no network beyond 127.0.0.1). It speaks enough of RFC 5321 for a real client
 * to deliver mail: EHLO, STARTTLS, AUTH PLAIN and LOGIN, MAIL, RCPT, DATA, RSET, QUIT. It records what it receives and can be told to
 * refuse a recipient, fail the message, or drop the connection, so failure handling can be tested. It is a stand-in for a provider,
 * not a provider: passing against it is not evidence that a real provider works (owner item O-2).
 */
export interface ReceivedMail { from: string; to: string[]; data: string; user: string | null; encrypted: boolean }
export interface FakeSmtpOptions {
  user?: string; password?: string;
  /** Offer and accept STARTTLS. */ starttls?: boolean;
  /** Encrypted from the first byte (SMTPS). */ implicitTls?: boolean;
  /** Reply to RCPT TO for an address with this code and text (for example 550), or null to accept. */ rejectRcpt?: (addr: string) => string | null;
  /** Reply to the end of DATA with this (for example '451 try later'), or null to accept. */ failData?: () => string | null;
  /** Close the socket instead of answering the greeting. */ dropConnections?: () => boolean;
  /** Echo the credentials in the failure text, as a careless server might. */ echoAuthInErrors?: boolean;
}

export function makeCert() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'fakesmtp-'));
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', path.join(dir, 'k.pem'), '-out', path.join(dir, 'c.pem'), '-days', '2', '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1'], { stdio: 'ignore' });
  const out = { key: readFileSync(path.join(dir, 'k.pem'), 'utf8'), cert: readFileSync(path.join(dir, 'c.pem'), 'utf8') };
  rmSync(dir, { recursive: true, force: true });
  return out;
}

export async function startFakeSmtp(opts: FakeSmtpOptions = {}) {
  const cert = opts.starttls || opts.implicitTls ? makeCert() : null;
  const mails: ReceivedMail[] = [];
  const commands: string[] = [];
  const sockets = new Set<net.Socket>();

  const handle = (raw: net.Socket, encryptedAtStart: boolean) => {
    let sock: net.Socket = raw;
    let encrypted = encryptedAtStart;
    let user: string | null = null;
    let from = ''; let to: string[] = [];
    let mode: 'cmd' | 'data' | 'auth-user' | 'auth-pass' | 'auth-plain' = 'cmd';
    let buf = '';
    const reply = (s: string) => { if (!sock.destroyed) sock.write(`${s}\r\n`); };
    sockets.add(raw); raw.on('close', () => sockets.delete(raw)); raw.on('error', () => undefined);
    if (opts.dropConnections?.()) { raw.destroy(); return; }
    const finishAuth = (u: string, p: string) => {
      commands.push(`AUTH-RESULT user=${u}`);
      if (u === opts.user && p === opts.password) { user = u; reply('235 2.7.0 Authentication successful'); } else reply(opts.echoAuthInErrors ? `535 5.7.8 Authentication failed for ${u} with password ${p}` : '535 5.7.8 Authentication credentials invalid');
    };
    const onLine = (line: string) => {
      if (mode === 'data') {
        if (line === '.') {
          mode = 'cmd';
          const fail = opts.failData?.();
          if (fail) { reply(fail); return; }
          mails.push({ from, to, data: dataBuf.replace(/\r\n\.\./g, '\r\n.'), user, encrypted }); dataBuf = '';
          reply('250 2.0.0 queued');
        } else dataBuf += `${line}\r\n`;
        return;
      }
      if (mode === 'auth-plain') { mode = 'cmd'; const [, u, p] = Buffer.from(line, 'base64').toString().split('\0'); finishAuth(u ?? '', p ?? ''); return; }
      if (mode === 'auth-user') { authUser = Buffer.from(line, 'base64').toString(); mode = 'auth-pass'; reply('334 UGFzc3dvcmQ6'); return; }
      if (mode === 'auth-pass') { mode = 'cmd'; finishAuth(authUser, Buffer.from(line, 'base64').toString()); return; }
      commands.push(line.replace(/^(AUTH \w+ ).+/i, '$1[credentials]'));
      const [verb = '', ...rest] = line.split(' ');
      switch (verb.toUpperCase()) {
        case 'EHLO': case 'HELO': {
          const caps = ['250-localhost', '250-8BITMIME', ...(opts.starttls && !encrypted ? ['250-STARTTLS'] : []), ...(opts.user && (encrypted || !opts.starttls) ? ['250-AUTH PLAIN LOGIN'] : [])];
          reply([...caps, '250 SIZE 10485760'].join('\r\n')); break;
        }
        case 'STARTTLS': {
          if (!opts.starttls || !cert) { reply('502 not supported'); break; }
          reply('220 2.0.0 Ready to start TLS');
          const secure = new tls.TLSSocket(sock, { isServer: true, key: cert.key, cert: cert.cert });
          secure.on('data', onData); secure.on('error', () => undefined);
          sock = secure; encrypted = true; buf = ''; break;
        }
        case 'AUTH': {
          if (!opts.user) { reply('503 no auth'); break; }
          if (opts.starttls && !encrypted) { reply('530 5.7.0 Must issue a STARTTLS command first'); break; }
          const kind = (rest[0] ?? '').toUpperCase();
          if (kind === 'PLAIN') { if (rest[1]) { const [, u, p] = Buffer.from(rest[1], 'base64').toString().split('\0'); finishAuth(u ?? '', p ?? ''); } else { mode = 'auth-plain'; reply('334 '); } }
          else if (kind === 'LOGIN') { if (rest[1]) { authUser = Buffer.from(rest[1], 'base64').toString(); mode = 'auth-pass'; reply('334 UGFzc3dvcmQ6'); } else { mode = 'auth-user'; reply('334 VXNlcm5hbWU6'); } }
          else reply('504 unrecognized mechanism');
          break;
        }
        case 'MAIL': {
          if (opts.user && !user) { reply('530 5.7.0 Authentication required'); break; }
          from = /<([^>]*)>/.exec(line)?.[1] ?? ''; to = []; reply('250 2.1.0 OK'); break;
        }
        case 'RCPT': {
          const addr = /<([^>]*)>/.exec(line)?.[1] ?? '';
          const refuse = opts.rejectRcpt?.(addr);
          if (refuse) { reply(refuse); break; }
          to.push(addr); reply('250 2.1.5 OK'); break;
        }
        case 'DATA': if (!to.length) reply('503 no valid recipients'); else { mode = 'data'; dataBuf = ''; reply('354 End data with <CR><LF>.<CR><LF>'); } break;
        case 'RSET': from = ''; to = []; reply('250 OK'); break;
        case 'NOOP': reply('250 OK'); break;
        case 'QUIT': reply('221 Bye'); sock.end(); break;
        default: reply('502 5.5.2 command not recognized');
      }
    };
    let dataBuf = ''; let authUser = '';
    const onData = (chunk: Buffer) => {
      buf += chunk.toString('utf8');
      let i: number;
      while ((i = buf.indexOf('\r\n')) >= 0) { const line = buf.slice(0, i); buf = buf.slice(i + 2); onLine(line); }
    };
    sock.on('data', onData);
    reply('220 localhost ESMTP fake');
  };

  const server = opts.implicitTls
    ? tls.createServer({ key: cert!.key, cert: cert!.cert }, (s) => handle(s, true))
    : net.createServer((s) => handle(s, false));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as net.AddressInfo).port;
  return {
    port, mails, commands, cert,
    close: () => new Promise<void>((resolve) => { for (const s of sockets) s.destroy(); server.close(() => resolve()); }),
  };
}
