#!/usr/bin/env node
// Single-user Google Workspace helper.
// Local OAuth + Gmail/Drive/Calendar/Sheets/Docs primitives + opinionated
// label-sync/swap/bury operations for vendor-ops style inbox triage.
//
// Designed for one human's workstation, not a service-account or multi-tenant
// setup. Token + credentials sit next to this file; OAuth bootstrap pops a
// browser the first time you run it.
//
// Usage:
//   node index.js whoami
//   node index.js gmail-search "QUERY" [N]
//   node index.js gmail-oldest "QUERY"
//   node index.js gmail-get <messageId>
//   node index.js gmail-signature
//   node index.js gmail-reply-draft <threadId> <bodyFile> [--bcc <addr>] [--to "..."] [--cc "..."]
//   node index.js gmail-send-draft <draftId>
//   node index.js gmail-thread-label-sync <threadId>
//     ^ propagate user-level labels across all messages in a thread so each
//       message has the union of labels. System labels (INBOX, SENT, etc.) are
//       preserved per-message. Idempotent. Reports which labels were added where.
//   node index.js gmail-thread-label-swap <threadId> <fromLabelName> <toLabelName>
//     ^ remove <fromLabelName> and add <toLabelName> across every message in the
//       thread. Use for status transitions (e.g. 02.waiting/me -> 02.waiting/customer
//       after sending a reply). Label names must be exact.
//   node index.js gmail-thread-bury <threadId>
//     ^ FULL BURY. Removes INBOX + 00.received + all 01.priority/* + all 02.waiting/*
//       from every message in the thread. Keeps zzzVendors/* and 05.events/* so the
//       thread stays associated with the vendor and event. Use when the thread is
//       effectively dead and we don't expect a natural reply to revive it. NOT the
//       same as archive (which only removes INBOX).
//   node index.js drive-list [N]
//
// For anything beyond these, require() this file and call buildService(api, version).

const fs = require('fs');
const path = require('path');
const http = require('http');
const { URL } = require('url');
const crypto = require('crypto');
// googleapis is lazy-loaded so pure-function exports (encodeHeaderRfc2047,
// SCOPES, etc.) can be required + tested without installing the full
// googleapis dependency tree. Auth + API calls still require it.
let _google = null;
function googleapis() {
  if (_google) return _google;
  _google = require('googleapis').google;
  return _google;
}

const HERE = __dirname;
const CRED_PATH = path.join(HERE, 'credentials.json');
const TOKEN_PATH = path.join(HERE, 'token.json');

const SCOPES = [
  'https://www.googleapis.com/auth/gmail.modify',
  'https://www.googleapis.com/auth/gmail.settings.basic',
  'https://www.googleapis.com/auth/drive',
  'https://www.googleapis.com/auth/documents',
  'https://www.googleapis.com/auth/spreadsheets',
  'https://www.googleapis.com/auth/calendar',
  'https://www.googleapis.com/auth/userinfo.email',
];

function loadCreds() {
  const raw = JSON.parse(fs.readFileSync(CRED_PATH, 'utf8'));
  return raw.installed || raw.web;
}

async function runLocalAuthFlow(oAuth2Client) {
  return new Promise((resolve, reject) => {
    const state = crypto.randomBytes(16).toString('hex');
    const server = http.createServer(async (req, res) => {
      try {
        const u = new URL(req.url, 'http://localhost');
        if (!u.searchParams.has('code')) {
          res.writeHead(404);
          res.end();
          return;
        }
        if (u.searchParams.get('state') !== state) {
          res.writeHead(400);
          res.end('state mismatch');
          reject(new Error('state mismatch'));
          return;
        }
        const code = u.searchParams.get('code');
        const { tokens } = await oAuth2Client.getToken({
          code,
          redirect_uri: redirectUri,
        });
        oAuth2Client.setCredentials(tokens);
        fs.writeFileSync(TOKEN_PATH, JSON.stringify(tokens, null, 2));
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<h1>Authorized.</h1><p>You can close this tab and return to the terminal.</p>');
        server.close();
        resolve(tokens);
      } catch (e) {
        res.writeHead(500);
        res.end('error: ' + e.message);
        server.close();
        reject(e);
      }
    });

    let redirectUri;
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      redirectUri = `http://localhost:${port}`;
      oAuth2Client.redirectUri = redirectUri;
      const authUrl = oAuth2Client.generateAuthUrl({
        access_type: 'offline',
        prompt: 'consent',
        scope: SCOPES,
        state,
        redirect_uri: redirectUri,
      });
      console.error('\nOpen this URL in your browser to authorize:');
      console.error('\n  ' + authUrl + '\n');
      import('open').then(({ default: open }) => {
        open(authUrl).catch(() => {});
      }).catch(() => {});
    });
  });
}

async function getAuthClient() {
  const creds = loadCreds();
  const oAuth2Client = new (googleapis()).auth.OAuth2(
    creds.client_id,
    creds.client_secret,
    creds.redirect_uris ? creds.redirect_uris[0] : 'http://localhost'
  );
  if (fs.existsSync(TOKEN_PATH)) {
    const tokens = JSON.parse(fs.readFileSync(TOKEN_PATH, 'utf8'));
    oAuth2Client.setCredentials(tokens);
    oAuth2Client.on('tokens', (t) => {
      const current = JSON.parse(fs.readFileSync(TOKEN_PATH, 'utf8'));
      fs.writeFileSync(TOKEN_PATH, JSON.stringify({ ...current, ...t }, null, 2));
    });
    return oAuth2Client;
  }
  await runLocalAuthFlow(oAuth2Client);
  return oAuth2Client;
}

async function buildService(api, version) {
  const auth = await getAuthClient();
  const svc = googleapis()[api]({ version, auth });
  // For Gmail, wrap drafts.send + messages.send with a duplicate-outbound guard.
  // Catches the case where two parallel sessions stage the same outbound on
  // different threadIds and both try to send. The per-thread "no_duplicate_drafts"
  // rule doesn't cover this (different threadIds = different keys).
  if (api === 'gmail') {
    const origDraftsSend = svc.users.drafts.send.bind(svc.users.drafts);
    svc.users.drafts.send = async (params) => {
      if (!process.env.GWORKSPACE_SKIP_DUP_GUARD) {
        try { await assertNoRecentDuplicateOutbound(svc, { draftId: params?.requestBody?.id || params?.id }); }
        catch (e) { console.error('DUP-GUARD BLOCK (drafts.send): ' + e.message); throw e; }
      }
      return origDraftsSend(params);
    };
    const origMessagesSend = svc.users.messages.send.bind(svc.users.messages);
    svc.users.messages.send = async (params) => {
      if (!process.env.GWORKSPACE_SKIP_DUP_GUARD) {
        try { await assertNoRecentDuplicateOutbound(svc, { rawBase64Url: params?.requestBody?.raw }); }
        catch (e) { console.error('DUP-GUARD BLOCK (messages.send): ' + e.message); throw e; }
      }
      return origMessagesSend(params);
    };
  }
  return svc;
}

// Pre-send dup guard. Either:
//   - draftId: pull the draft, extract To+Subject+body-hash, search SENT for matches
//   - rawBase64Url: decode raw MIME, extract same, search SENT
// Throws if a match is found in the last 24h. Set GWORKSPACE_SKIP_DUP_GUARD=1 to bypass.
async function assertNoRecentDuplicateOutbound(gmail, { draftId, rawBase64Url, withinHours = 24 }) {
  let to = '', subject = '', bodyText = '';
  if (draftId) {
    const d = await gmail.users.drafts.get({ userId: 'me', id: draftId, format: 'full' });
    const msg = d.data.message;
    const headers = (msg.payload?.headers || []);
    to = (headers.find(h => h.name.toLowerCase() === 'to')?.value || '').toLowerCase();
    subject = (headers.find(h => h.name.toLowerCase() === 'subject')?.value || '').trim();
    bodyText = extractMessageBodyText(msg).trim();
  } else if (rawBase64Url) {
    const raw = Buffer.from(rawBase64Url.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
    const headerSep = raw.indexOf('\r\n\r\n');
    const head = headerSep > 0 ? raw.slice(0, headerSep) : raw;
    const body = headerSep > 0 ? raw.slice(headerSep + 4) : '';
    const m1 = head.match(/^To:\s*(.+?)$/im); if (m1) to = m1[1].trim().toLowerCase();
    const m2 = head.match(/^Subject:\s*(.+?)$/im); if (m2) subject = m2[1].trim();
    bodyText = body.replace(/<[^>]+>/g, '').trim();
  } else {
    return; // nothing to check
  }
  if (!to || !subject) return; // can't check without these
  // Extract bare email addr from To (drop "Name <addr>")
  const addrMatch = to.match(/<([^>]+)>/);
  const addr = (addrMatch ? addrMatch[1] : to).split(',')[0].trim();
  // Subject normalize: strip "Re:" / "Fwd:"
  const subjNorm = subject.replace(/^(Re|Fwd|Fw):\s*/i, '').trim();
  // Search SENT recently for same recipient + same normalized subject
  const q = `in:sent to:${addr} subject:"${subjNorm.replace(/"/g, '')}" newer_than:${withinHours}h`;
  const r = await gmail.users.messages.list({ userId: 'me', q, maxResults: 5 });
  const hits = r.data.messages || [];
  if (!hits.length) return;
  // Body fingerprint match (first 80 chars after normalize+trim, lowercased)
  const fp = bodyText.replace(/\s+/g, ' ').trim().slice(0, 80).toLowerCase();
  if (!fp) return; // empty body, can't fingerprint
  for (const h of hits) {
    const m = await gmail.users.messages.get({ userId: 'me', id: h.id, format: 'full' });
    const sentBody = extractMessageBodyText(m.data).replace(/\s+/g, ' ').trim().slice(0, 80).toLowerCase();
    if (sentBody && sentBody === fp) {
      throw new Error(`DUP-GUARD: same outbound already sent ${withinHours}h ago. To=${addr}, Subject="${subjNorm}", existing msg_id=${h.id} (https://mail.google.com/mail/u/0/#sent/${h.id}). Set env GWORKSPACE_SKIP_DUP_GUARD=1 to override.`);
    }
  }
}

function extractMessageBodyText(msg) {
  function walk(p) {
    if (!p) return '';
    if (p.body?.data && (p.mimeType === 'text/plain' || p.mimeType === 'text/html')) {
      try {
        let raw = Buffer.from(p.body.data, 'base64').toString('utf8');
        if (p.mimeType === 'text/html') raw = raw.replace(/<[^>]+>/g, '');
        return raw + '\n';
      } catch { return ''; }
    }
    let out = '';
    for (const c of (p.parts || [])) out += walk(c);
    return out;
  }
  return walk(msg.payload || {});
}

// ---------- CLI subcommands ----------

async function cmdWhoami() {
  const oauth2 = await buildService('oauth2', 'v2');
  const me = await oauth2.userinfo.get();
  console.log(JSON.stringify(me.data, null, 2));
}

async function loadLabelMap(gmail) {
  const res = await gmail.users.labels.list({ userId: 'me' });
  const map = {};
  for (const l of res.data.labels || []) map[l.id] = l.name;
  return map;
}

async function loadLabelMeta(gmail) {
  // returns { byId: { id: {name,type} }, userIds: Set, systemIds: Set }
  const res = await gmail.users.labels.list({ userId: 'me' });
  const byId = {};
  const userIds = new Set();
  const systemIds = new Set();
  for (const l of res.data.labels || []) {
    byId[l.id] = { name: l.name, type: l.type };
    if (l.type === 'user') userIds.add(l.id);
    else systemIds.add(l.id);
  }
  return { byId, userIds, systemIds };
}

async function cmdGmailThreadBury(threadId) {
  if (!threadId) {
    console.error('usage: gmail-thread-bury <threadId>');
    process.exit(1);
  }
  const gmail = await buildService('gmail', 'v1');
  const meta = await loadLabelMeta(gmail);

  // Figure out which label IDs to strip. Rules:
  //   - INBOX (system)
  //   - any user label with name "00.received"
  //   - any user label with name "01.priority" or starting with "01.priority/"
  //   - any user label with name "02.waiting" or starting with "02.waiting/"
  const stripIds = new Set();
  stripIds.add('INBOX');
  for (const [id, info] of Object.entries(meta.byId)) {
    if (info.type !== 'user') continue;
    const n = info.name;
    if (n === '00.received') stripIds.add(id);
    if (n === '01.priority' || n.startsWith('01.priority/')) stripIds.add(id);
    if (n === '02.waiting' || n.startsWith('02.waiting/')) stripIds.add(id);
  }

  const thread = await gmail.users.threads.get({ userId: 'me', id: threadId, format: 'minimal' });
  const messages = thread.data.messages || [];
  if (!messages.length) throw new Error('thread has no messages: ' + threadId);

  let modified = 0;
  const strippedNames = new Set();
  const errors = [];
  for (const m of messages) {
    const current = new Set(m.labelIds || []);
    const removeIds = [...stripIds].filter((lid) => current.has(lid));
    if (removeIds.length === 0) continue;
    try {
      await gmail.users.messages.modify({
        userId: 'me',
        id: m.id,
        requestBody: { removeLabelIds: removeIds },
      });
      modified++;
      for (const lid of removeIds) {
        strippedNames.add(lid === 'INBOX' ? 'INBOX' : meta.byId[lid].name);
      }
    } catch (e) {
      errors.push({ id: m.id, error: e.message });
    }
  }

  console.log(
    JSON.stringify(
      {
        ok: errors.length === 0,
        threadId,
        messagesInThread: messages.length,
        modified,
        labelsStripped: [...strippedNames].sort(),
        errors,
      },
      null,
      2
    )
  );
}

async function cmdGmailThreadLabelSwap(threadId, fromName, toName) {
  if (!threadId || !fromName || !toName) {
    console.error('usage: gmail-thread-label-swap <threadId> <fromLabelName> <toLabelName>');
    process.exit(1);
  }
  const gmail = await buildService('gmail', 'v1');
  const meta = await loadLabelMeta(gmail);
  // find label IDs by name
  const byName = {};
  for (const [id, info] of Object.entries(meta.byId)) byName[info.name] = id;
  const fromId = byName[fromName];
  const toId = byName[toName];
  if (!fromId && fromName) {
    console.error(`label not found: ${fromName}`);
    process.exit(1);
  }
  if (!toId) {
    console.error(`label not found: ${toName}`);
    process.exit(1);
  }
  const thread = await gmail.users.threads.get({ userId: 'me', id: threadId, format: 'minimal' });
  const messages = thread.data.messages || [];
  let modified = 0;
  for (const m of messages) {
    const current = new Set(m.labelIds || []);
    const addIds = !current.has(toId) ? [toId] : [];
    const removeIds = current.has(fromId) ? [fromId] : [];
    if (addIds.length || removeIds.length) {
      await gmail.users.messages.modify({
        userId: 'me',
        id: m.id,
        requestBody: { addLabelIds: addIds, removeLabelIds: removeIds },
      });
      modified++;
    }
  }
  console.log(
    JSON.stringify(
      { ok: true, threadId, messagesInThread: messages.length, modified, removed: fromName, added: toName },
      null,
      2
    )
  );
}

async function cmdGmailThreadLabelSync(threadId) {
  if (!threadId) {
    console.error('usage: gmail-thread-label-sync <threadId>');
    process.exit(1);
  }
  const gmail = await buildService('gmail', 'v1');
  const meta = await loadLabelMeta(gmail);
  const thread = await gmail.users.threads.get({ userId: 'me', id: threadId, format: 'minimal' });
  const messages = thread.data.messages || [];
  if (!messages.length) {
    console.error('thread has no messages: ' + threadId);
    process.exit(1);
  }
  // union of user labels across all messages in the thread
  const unionUserLabels = new Set();
  for (const m of messages) {
    for (const lid of m.labelIds || []) {
      if (meta.userIds.has(lid)) unionUserLabels.add(lid);
    }
  }
  const unionArr = [...unionUserLabels];
  const unionNames = unionArr.map((id) => meta.byId[id].name).sort();

  // for each message, determine missing user labels and add
  const changes = [];
  for (const m of messages) {
    const current = new Set(m.labelIds || []);
    const missing = unionArr.filter((lid) => !current.has(lid));
    if (missing.length > 0) {
      await gmail.users.messages.modify({
        userId: 'me',
        id: m.id,
        requestBody: { addLabelIds: missing },
      });
      changes.push({
        messageId: m.id,
        addedLabels: missing.map((id) => meta.byId[id].name),
      });
    }
  }
  console.log(
    JSON.stringify(
      {
        ok: true,
        threadId,
        messagesInThread: messages.length,
        unionUserLabels: unionNames,
        modified: changes.length,
        changes,
      },
      null,
      2
    )
  );
}

async function cmdGmailSearch(query, n) {
  const gmail = await buildService('gmail', 'v1');
  const maxResults = Math.min(Number(n) || 20, 500);
  const labelMap = await loadLabelMap(gmail);
  const res = await gmail.users.messages.list({
    userId: 'me',
    q: query,
    maxResults,
  });
  const msgs = res.data.messages || [];
  const out = [];
  for (const m of msgs) {
    const msg = await gmail.users.messages.get({
      userId: 'me',
      id: m.id,
      format: 'metadata',
      metadataHeaders: ['From', 'To', 'Subject', 'Date'],
    });
    const hdrs = Object.fromEntries(
      (msg.data.payload.headers || []).map((h) => [h.name, h.value])
    );
    const labelIds = msg.data.labelIds || [];
    const labels = labelIds.map((id) => labelMap[id] || id);
    out.push({
      id: m.id,
      threadId: m.threadId,
      internalDate: msg.data.internalDate,
      snippet: msg.data.snippet,
      headers: hdrs,
      labels,
    });
  }
  console.log(JSON.stringify({ count: out.length, messages: out }, null, 2));
}

async function cmdGmailOldest(query) {
  const gmail = await buildService('gmail', 'v1');
  let pageToken = undefined;
  let lastId = null;
  let total = 0;
  while (true) {
    const res = await gmail.users.messages.list({
      userId: 'me',
      q: query,
      maxResults: 500,
      pageToken,
    });
    const msgs = res.data.messages || [];
    total += msgs.length;
    if (msgs.length > 0) lastId = msgs[msgs.length - 1].id;
    if (!res.data.nextPageToken) break;
    pageToken = res.data.nextPageToken;
  }
  if (!lastId) {
    console.log(JSON.stringify({ found: false, total }, null, 2));
    return;
  }
  const msg = await gmail.users.messages.get({
    userId: 'me',
    id: lastId,
    format: 'metadata',
    metadataHeaders: ['From', 'To', 'Subject', 'Date'],
  });
  const hdrs = Object.fromEntries(
    (msg.data.payload.headers || []).map((h) => [h.name, h.value])
  );
  console.log(
    JSON.stringify(
      {
        total,
        id: lastId,
        threadId: msg.data.threadId,
        internalDate: msg.data.internalDate,
        snippet: msg.data.snippet,
        headers: hdrs,
      },
      null,
      2
    )
  );
}

async function cmdGmailGet(id) {
  const gmail = await buildService('gmail', 'v1');
  const msg = await gmail.users.messages.get({
    userId: 'me',
    id,
    format: 'full',
  });
  console.log(JSON.stringify(msg.data, null, 2));
}

// gmail-thread <threadId>
// Authoritative thread inspection. Returns every message with from/to/cc/date/
// subject/snippet/labels. USE THIS instead of keyword search when answering
// "did X reply on thread Y" — keyword searches miss replies that don't contain
// the keyword. Captured 2026-05-04 after I twice used keyword search to check
// for accounting replies and missed nothing only by luck.
async function cmdGmailThread(threadId, flagArgs = []) {
  if (!threadId) {
    console.error('usage: gmail-thread <threadId> [--check-reply-from <email>]');
    process.exit(1);
  }
  let checkReplyFrom = null;
  for (let i = 0; i < flagArgs.length; i++) {
    if (flagArgs[i] === '--check-reply-from') checkReplyFrom = String(flagArgs[++i] || '').toLowerCase();
  }
  const gmail = await buildService('gmail', 'v1');
  const t = await gmail.users.threads.get({
    userId: 'me',
    id: threadId,
    format: 'metadata',
    metadataHeaders: ['From', 'To', 'Cc', 'Bcc', 'Subject', 'Date', 'Message-Id', 'In-Reply-To'],
  });
  const messages = (t.data.messages || []).map((m) => {
    const h = Object.fromEntries((m.payload?.headers || []).map((x) => [x.name, x.value]));
    return {
      id: m.id,
      threadId: m.threadId,
      internalDate: m.internalDate,
      from: h.From || '',
      to: h.To || '',
      cc: h.Cc || '',
      bcc: h.Bcc || '',
      subject: h.Subject || '',
      date: h.Date || '',
      messageId: h['Message-Id'] || '',
      inReplyTo: h['In-Reply-To'] || '',
      snippet: m.snippet || '',
      labels: m.labelIds || [],
    };
  });
  const out = { threadId, messageCount: messages.length, messages };
  if (checkReplyFrom) {
    const matched = messages.filter((m) => m.from.toLowerCase().includes(checkReplyFrom));
    out.checkReplyFrom = checkReplyFrom;
    out.replyFound = matched.length > 0;
    out.matchedMessageIds = matched.map((m) => m.id);
  }
  console.log(JSON.stringify(out, null, 2));
}

async function cmdGmailSendDraft(draftId) {
  if (!draftId) {
    console.error('usage: gmail-send-draft <draftId>');
    process.exit(1);
  }
  const gmail = await buildService('gmail', 'v1');
  const res = await gmail.users.drafts.send({
    userId: 'me',
    requestBody: { id: draftId },
  });
  const sentMessageId = res.data.id;
  const threadId = res.data.threadId;

  // Auto-archive: remove INBOX label from every message in the thread after
  // a successful send. Status-label flip (e.g. waiting-me -> waiting-customer)
  // is a separate concern handled by post-send hooks if you wire them up.
  let archived = { messages: 0 };
  try {
    const thread = await gmail.users.threads.get({ userId: 'me', id: threadId, format: 'minimal' });
    const messages = thread.data.messages || [];
    for (const m of messages) {
      const hasInbox = (m.labelIds || []).includes('INBOX');
      if (hasInbox) {
        await gmail.users.messages.modify({
          userId: 'me',
          id: m.id,
          requestBody: { removeLabelIds: ['INBOX'] },
        });
        archived.messages++;
      }
    }
  } catch (e) {
    archived.error = e.message;
  }

  // Cockpit sync: immediately resolve the matching action item so the cockpit
  // doesn't show a stale staged-draft card until the next full feed rebuild.
  // Best-effort — any failure here must NOT break the send result.
  let cockpitResolved = null;
  try {
    const { resolveCockpitItemForSend } = require('./_cockpit_resolve_on_send.cjs');
    cockpitResolved = resolveCockpitItemForSend({ threadId, draftId });
  } catch (e) {
    process.stderr.write(`[gmail-send-draft] cockpit resolve warning (non-fatal): ${e.message}\n`);
  }

  console.log(
    JSON.stringify(
      {
        ok: true,
        sentMessageId,
        threadId,
        labels: res.data.labelIds || [],
        autoArchive: archived,
        cockpitResolved,
      },
      null,
      2
    )
  );
}

async function cmdDriveList(n) {
  const drive = await buildService('drive', 'v3');
  const res = await drive.files.list({
    pageSize: Number(n) || 20,
    fields: 'files(id, name, mimeType, modifiedTime, owners(emailAddress))',
  });
  console.log(JSON.stringify(res.data, null, 2));
}

// ---------- Gmail helpers ----------

function headerLookup(headers, name) {
  const h = headers.find((x) => x.name.toLowerCase() === name.toLowerCase());
  return h ? h.value : '';
}

function parseAddressList(str) {
  if (!str) return [];
  // Split on commas that are NOT inside double quotes or angle brackets.
  // "Lastname, Firstname" <x@y> , other@z  =>  ['"Lastname, Firstname" <x@y>', 'other@z']
  const out = [];
  let buf = '';
  let inQuote = false;
  let inAngle = false;
  for (const ch of str) {
    if (ch === '"' && !inAngle) inQuote = !inQuote;
    else if (ch === '<' && !inQuote) inAngle = true;
    else if (ch === '>' && !inQuote) inAngle = false;
    if (ch === ',' && !inQuote && !inAngle) {
      const t = buf.trim();
      if (t) out.push(t);
      buf = '';
    } else {
      buf += ch;
    }
  }
  const t = buf.trim();
  if (t) out.push(t);
  return out;
}

function stripAddressFromList(list, addressToRemove) {
  if (!addressToRemove) return list;
  const needle = addressToRemove.toLowerCase();
  return list.filter((entry) => !entry.toLowerCase().includes(needle));
}

function decodeBase64Url(str) {
  const s = str.replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(s, 'base64').toString('utf8');
}

function collectPlainText(payload) {
  // recurse through payload parts, collect text/plain bodies
  const out = [];
  function walk(part) {
    if (!part) return;
    const mime = (part.mimeType || '').toLowerCase();
    if (mime === 'text/plain' && part.body && part.body.data) {
      out.push(decodeBase64Url(part.body.data));
    }
    if (part.parts && Array.isArray(part.parts)) {
      for (const p of part.parts) walk(p);
    }
  }
  walk(payload);
  return out.join('\n\n');
}

function collectHtml(payload) {
  // recurse through payload parts, collect text/html bodies (prefer this over plain text for quoting)
  const out = [];
  function walk(part) {
    if (!part) return;
    const mime = (part.mimeType || '').toLowerCase();
    if (mime === 'text/html' && part.body && part.body.data) {
      out.push(decodeBase64Url(part.body.data));
    }
    if (part.parts && Array.isArray(part.parts)) {
      for (const p of part.parts) walk(p);
    }
  }
  walk(payload);
  return out.join('\n');
}

function extractBodyInner(html) {
  // if the HTML is a full document, pull out just the <body>...</body> content
  // so the quoted region doesn't drop <html>/<head>/<style> garbage into the reply
  if (!html) return '';
  const m = html.match(/<body[^>]*>([\s\S]*)<\/body>/i);
  if (m) return m[1];
  // also strip any standalone <head>...</head> if present without a full doc
  return html.replace(/<head[^>]*>[\s\S]*?<\/head>/gi, '');
}

function stripDangerousTags(html) {
  if (!html) return '';
  // remove <script>, <style>, <meta>, <link>, <iframe>, and on* event handlers - Gmail would strip them anyway
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<meta[^>]*>/gi, '')
    .replace(/<link[^>]*>/gi, '')
    .replace(/<iframe[\s\S]*?<\/iframe>/gi, '')
    .replace(/\son[a-z]+\s*=\s*"[^"]*"/gi, '')
    .replace(/\son[a-z]+\s*=\s*'[^']*'/gi, '');
}

function htmlEscape(s) {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function looksLikeHtml(txt) {
  // Heuristic: starts with an HTML tag after optional whitespace, OR contains common block tags.
  const t = (txt || '').trim();
  if (!t) return false;
  if (/^<\s*(div|p|br|span|a|table|html|body|h[1-6]|ul|ol|li)\b/i.test(t)) return true;
  // Multiple HTML tags scattered through the body
  const tagCount = (t.match(/<\s*\/?\s*(div|p|br|span|a|table|tr|td|h[1-6]|ul|ol|li)\b/gi) || []).length;
  return tagCount >= 2;
}

function textToHtmlParagraphs(txt) {
  // If the input already looks like HTML, pass through without escaping.
  if (looksLikeHtml(txt)) return txt;
  const paragraphs = txt.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  return paragraphs
    .map((p) => `<p>${htmlEscape(p).replace(/\n/g, '<br>')}</p>`)
    .join('\n');
}

// Render-quality lint for staged Gmail drafts. Fetches the just-created
// message back and inspects rendered HTML + plain bodies + Subject for known
// anti-patterns (over-spacing, empty <p></p>, mojibake, encoded-word leak,
// empty subject). On failure: deletes the draft so a broken draft never
// reaches the user with an "ok" URL, then throws with the issue list.
async function verifyStagedDraft(gmail, { draftId, messageId }) {
  const m = await gmail.users.messages.get({ userId: 'me', id: messageId, format: 'full' });
  let htmlBody = '';
  let plainBody = '';
  function walk(p) {
    if (p.mimeType === 'text/html' && p.body && p.body.data) htmlBody += Buffer.from(p.body.data, 'base64').toString('utf8');
    if (p.mimeType === 'text/plain' && p.body && p.body.data) plainBody += Buffer.from(p.body.data, 'base64').toString('utf8');
    (p.parts || []).forEach(walk);
  }
  walk(m.data.payload);
  const headers = m.data.payload && m.data.payload.headers ? m.data.payload.headers : [];
  const subject = (headers.find((h) => h.name && h.name.toLowerCase() === 'subject') || {}).value || '';

  const issues = [];
  // Strip quoted-reply chain (<blockquote>...</blockquote>) before scanning
  // for formatting issues. Quoted prior messages routinely contain 3+ <br>
  // and empty <p></p> from upstream signatures; failing on those would be a
  // false positive on the new content we're writing.
  const newContentHtml = htmlBody.replace(/<blockquote[\s\S]*?<\/blockquote>/gi, '');
  if (/(?:<br\s*\/?>\s*){3,}/i.test(newContentHtml)) issues.push('over-spaced: 3+ consecutive <br> tags in HTML body');
  if (/<p>\s*<\/p>/i.test(newContentHtml)) issues.push('empty <p></p> block in HTML body');
  if (/\n{4,}/.test(plainBody)) issues.push('4+ consecutive newlines in plain-text body');
  for (const marker of ['â€"', 'â€™', 'â€œ', 'â€\x9d', 'Ã¢â‚¬']) {
    if (htmlBody.includes(marker) || plainBody.includes(marker) || subject.includes(marker)) {
      issues.push('mojibake marker present in body or subject (' + marker.slice(0, 4) + '…)');
      break;
    }
  }
  if (/=\?[\w-]+\?[BQ]\?/i.test(subject)) issues.push('RFC 2047 encoded-word leaked into decoded Subject (double-encoded?)');
  if (!subject || !subject.trim()) issues.push('empty Subject');

  if (issues.length > 0) {
    try { await gmail.users.drafts.delete({ userId: 'me', id: draftId }); } catch {}
    const err = new Error('Draft render lint FAILED — draft deleted. Issues:\n  - ' + issues.join('\n  - '));
    err.lintIssues = issues;
    throw err;
  }
  return { ok: true };
}

function buildGmailQuoteHtml(prevDate, prevFrom, prevHtml, prevTextFallback) {
  // Prefer real HTML from the previous message if available so inline formatting / links / tables
  // render natively inside the blockquote instead of looking like pasted text.
  let inner;
  if (prevHtml && prevHtml.trim()) {
    inner = stripDangerousTags(extractBodyInner(prevHtml));
  } else {
    inner = (prevTextFallback || '')
      .split('\n')
      .map((l) => htmlEscape(l))
      .join('<br>');
  }
  return (
    `<div class="gmail_quote gmail_quote_container">` +
    `<div dir="ltr" class="gmail_attr">On ${htmlEscape(prevDate)}, ${htmlEscape(prevFrom)} wrote:<br></div>` +
    `<blockquote class="gmail_quote" style="margin:0 0 0 .8ex;border-left:1px solid #ccc;padding-left:1ex">` +
    inner +
    `</blockquote></div>`
  );
}

function buildGmailQuoteText(prevDate, prevFrom, prevBodyText) {
  const lines = (prevBodyText || '').split('\n').map((l) => '> ' + l).join('\n');
  return `\nOn ${prevDate}, ${prevFrom} wrote:\n${lines}`;
}

function mimeTypeForFile(filePath) {
  const ext = (filePath.split('.').pop() || '').toLowerCase();
  const map = {
    zip: 'application/zip',
    pdf: 'application/pdf',
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    csv: 'text/csv',
    txt: 'text/plain',
    json: 'application/json',
    html: 'text/html',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    xls: 'application/vnd.ms-excel',
    doc: 'application/msword',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  };
  return map[ext] || 'application/octet-stream';
}

// RFC 2047 encoded-word for headers containing non-ASCII bytes.
// Without this, en-dash (–), em-dash (—), smart quotes etc. in Subject
// render as garbled "â€"" mojibake in mail clients that fall back to
// Windows-1252 when the Subject header has raw UTF-8 bytes.
function encodeHeaderRfc2047(s) {
  if (!s) return '';
  // Pure ASCII: pass through unchanged
  if (/^[\x00-\x7F]*$/.test(s)) return s;
  // Encode as a single UTF-8 base64 word. Most Subject lines fit in one word.
  const b64 = Buffer.from(s, 'utf8').toString('base64');
  return `=?UTF-8?B?${b64}?=`;
}

function buildMimeReply({
  fromHeader,
  toList,
  ccList,
  bccList,
  subject,
  inReplyTo,
  references,
  plainBody,
  htmlBody,
  attachments,
}) {
  const altBoundary = '----=_gwa_' + crypto.randomBytes(8).toString('hex');
  const hasAttachments = Array.isArray(attachments) && attachments.length > 0;
  const mixedBoundary = hasAttachments ? '----=_gwm_' + crypto.randomBytes(8).toString('hex') : null;

  const lines = [];
  lines.push(`From: ${fromHeader}`);
  if (toList.length) lines.push(`To: ${toList.join(', ')}`);
  if (ccList.length) lines.push(`Cc: ${ccList.join(', ')}`);
  if (bccList.length) lines.push(`Bcc: ${bccList.join(', ')}`);
  lines.push(`Subject: ${encodeHeaderRfc2047(subject)}`);
  if (inReplyTo) lines.push(`In-Reply-To: ${inReplyTo}`);
  if (references) lines.push(`References: ${references}`);
  lines.push('MIME-Version: 1.0');

  if (hasAttachments) {
    lines.push(`Content-Type: multipart/mixed; boundary="${mixedBoundary}"`);
    lines.push('');
    lines.push(`--${mixedBoundary}`);
    lines.push(`Content-Type: multipart/alternative; boundary="${altBoundary}"`);
    lines.push('');
  } else {
    lines.push(`Content-Type: multipart/alternative; boundary="${altBoundary}"`);
    lines.push('');
  }

  lines.push(`--${altBoundary}`);
  lines.push('Content-Type: text/plain; charset="UTF-8"');
  lines.push('Content-Transfer-Encoding: 7bit');
  lines.push('');
  lines.push(plainBody);
  lines.push('');
  lines.push(`--${altBoundary}`);
  lines.push('Content-Type: text/html; charset="UTF-8"');
  lines.push('Content-Transfer-Encoding: 7bit');
  lines.push('');
  lines.push(htmlBody);
  lines.push('');
  lines.push(`--${altBoundary}--`);

  if (hasAttachments) {
    for (const a of attachments) {
      const fileName = a.split(/[\\/]/).pop();
      const mimeType = mimeTypeForFile(fileName);
      const data = fs.readFileSync(a);
      const b64 = data.toString('base64').replace(/(.{76})/g, '$1\r\n');
      lines.push('');
      lines.push(`--${mixedBoundary}`);
      lines.push(`Content-Type: ${mimeType}; name="${fileName}"`);
      lines.push('Content-Transfer-Encoding: base64');
      lines.push(`Content-Disposition: attachment; filename="${fileName}"`);
      lines.push('');
      lines.push(b64);
    }
    lines.push('');
    lines.push(`--${mixedBoundary}--`);
  }

  return lines.join('\r\n');
}

function toBase64Url(str) {
  return Buffer.from(str, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function cmdGmailSignature() {
  const gmail = await buildService('gmail', 'v1');
  const res = await gmail.users.settings.sendAs.list({ userId: 'me' });
  const sendAs = (res.data.sendAs || []).find((s) => s.isDefault) || (res.data.sendAs || [])[0];
  if (!sendAs) {
    console.log(JSON.stringify({ signature: '', email: '' }, null, 2));
    return;
  }
  console.log(
    JSON.stringify(
      {
        email: sendAs.sendAsEmail,
        displayName: sendAs.displayName || '',
        signature: sendAs.signature || '',
      },
      null,
      2
    )
  );
}

/**
 * detectLegalFlavor — scan body + subject text for legal-flavored keywords.
 * Returns { triggered: true, keyword, context } or { triggered: false }.
 *
 * Used by the legal-BCC gate. The scan is case-insensitive.
 * HTML tags are stripped from bodyText before scanning so keywords embedded
 * in rich-text aren't missed.
 */
function detectLegalFlavor(bodyText, subject) {
  // Strip HTML tags to plain text for scanning
  const plainBody = bodyText
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
  const subjectPlain = (subject || '').replace(/<[^>]+>/g, ' ').trim();
  const combined = subjectPlain + ' ' + plainBody;

  // Ordered list of patterns to test (first match wins for error reporting)
  const patterns = [
    // Acronyms / exact terms (word-boundary to avoid false positives like "TCPAM")
    { re: /\bMSA\b/,                              label: 'MSA' },
    { re: /\bNDA\b/,                              label: 'NDA' },
    { re: /\bSLA\b/,                              label: 'SLA' },
    { re: /\bTCPA\b/,                             label: 'TCPA' },
    // Full phrases
    { re: /master\s+service\s+agreement/i,        label: 'Master Service Agreement' },
    { re: /master\s+lead\s+seller\s+agreement/i,  label: 'Master Lead Seller Agreement' },
    { re: /lead\s+buyer\s+agreement/i,            label: 'Lead Buyer Agreement' },
    { re: /indemnif(?:ication|y)/i,               label: 'indemnification' },
    { re: /carve[-\s]?out/i,                      label: 'carve-out' },
    { re: /liability\s+cap/i,                     label: 'liability cap' },
    { re: /redline/i,                             label: 'redline' },
    { re: /counter[-\s]?redline/i,                label: 'counter-redline' },
    { re: /\brevisions?\b/i,                      label: 'revisions' },
    { re: /proposed\s+language/i,                 label: 'proposed language' },
    { re: /\bamendment\b/i,                       label: 'amendment' },
    { re: /\baddendum\b/i,                        label: 'addendum' },
    { re: /e[-\s]?sign\b/i,                       label: 'e-sign' },
    { re: /box\s+sign/i,                          label: 'Box Sign' },
    { re: /\bexecutable\b/i,                      label: 'executable' },
    { re: /move\s+to\s+executable/i,              label: 'move to executable' },
    // Section sign + digit (e.g. §5.1 or §10)
    { re: /§\s*\d/,                               label: '§<section>' },
    // Legal team references
    { re: /our\s+legal\s+team/i,                  label: 'our legal team' },
    { re: /their\s+legal\s+team/i,                label: 'their legal team' },
  ];

  for (const { re, label } of patterns) {
    const m = combined.match(re);
    if (m) {
      // Grab a small context window around the match for the error message
      const idx = combined.indexOf(m[0]);
      const ctx = combined.slice(Math.max(0, idx - 40), Math.min(combined.length, idx + 60)).trim();
      return { triggered: true, keyword: label, context: ctx };
    }
  }
  return { triggered: false };
}

/**
 * validateDraftBody — shared validation for both gmail-reply-draft and
 * gmail-new-draft. Runs em-dash check, closing-signature check, and
 * legal-BCC gate. Returns bodyText unchanged after validation.
 *
 * Extracted here is logic that's identical between both callers. Anything
 * that differs (prior-outbound check order, ownership check) stays in the
 * individual functions to keep this helper a true shared core.
 *
 * @param {string} bodyText   — raw body string (plain or HTML)
 * @param {string[]} flagArgs — passthrough flag array
 * @param {string} callerName — e.g. "gmail-reply-draft" for error prefixes
 * @param {string} [subject]  — optional subject line for legal-flavor scan
 * @returns {string} bodyText (passed through unchanged after validation)
 */
function validateDraftBody(bodyText, flagArgs, callerName, subject) {
  // --- Em-dash check (opt-in) ---
  // LLM-generated drafts leak em-dashes that many human writers don't use.
  // Enable with GW_EMDASH_CHECK=1; bypass per-call via --skip-emdash-check.
  if (process.env.GW_EMDASH_CHECK === '1' && !flagArgs.includes('--skip-emdash-check')) {
    if (bodyText.includes('—')) {
      const idx = bodyText.indexOf('—');
      const ctx = bodyText.slice(Math.max(0, idx - 40), Math.min(bodyText.length, idx + 40));
      throw new Error(
        `${callerName}: em-dash (—) detected in body. ` +
        'Use commas/periods/parens/hyphens instead. Context: ' + JSON.stringify(ctx) +
        '. Pass --skip-emdash-check to override.'
      );
    }
  }

  // --- Closing-signature check (opt-in) ---
  // GW_CLOSING_GREETING + GW_CLOSING_NAME enforce a sign-off pair
  // (e.g. greeting="Thanks," name="Alex"). GW_FORBIDDEN_CLOSINGS is a
  // comma-separated list of greetings to reject outright. Skip entirely
  // if no env vars set.
  if (!flagArgs.includes('--skip-thanks-check')) {
    const greeting = (process.env.GW_CLOSING_GREETING || '').trim();
    const name     = (process.env.GW_CLOSING_NAME     || '').trim();
    const forbiddenStr = (process.env.GW_FORBIDDEN_CLOSINGS || '').trim();
    if (greeting || forbiddenStr) {
      const plain = bodyText
        .replace(/<\/?(div|p|br|span|h[1-6])[^>]*>/gi, '\n')
        .replace(/<[^>]+>/g, '')
        .replace(/&nbsp;/gi, ' ')
        .replace(/&amp;/g, '&')
        .trim();
      const lines = plain.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
      const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      if (greeting && name) {
        const greetRe = new RegExp(`^${esc(greeting).replace(/,?$/, ',?')}$`, 'i');
        const nameRe = new RegExp(`^${esc(name)}$`, 'i');
        const idx = lines.findIndex(l => greetRe.test(l));
        if (idx >= 0) {
          const next = lines[idx + 1] || '';
          if (!nameRe.test(next)) {
            throw new Error(
              `${callerName}: body has "${greeting}" but no "${name}" line directly after. ` +
              `Found next line: ${JSON.stringify(next)}. Pass --skip-thanks-check to override.`
            );
          }
        }
      }
      if (forbiddenStr) {
        const forbidden = forbiddenStr.split(',').map(s => s.trim()).filter(Boolean);
        const forbiddenRe = new RegExp(`^(${forbidden.map(esc).join('|')}),?$`, 'i');
        const hit = lines.find(l => forbiddenRe.test(l));
        if (hit) {
          throw new Error(
            `${callerName}: forbidden closing detected: ${JSON.stringify(hit)}. ` +
            'Pass --skip-thanks-check to override.'
          );
        }
      }
    }
  }

  // --- Legal-flavor BCC gate ---
  // Legal BCC gate is opt-in. Set GW_LEGAL_BCC to a comma-separated address
  // list (e.g. "counsel@yourco.com,paralegal@yourco.com") to require those
  // addresses on any draft that contains legal-flavored keywords. Skip the
  // gate entirely if not configured. Override per-call via --skip-legal-bcc-check.
  if (!flagArgs.includes('--skip-legal-bcc-check')) {
    const requiredBccList = (process.env.GW_LEGAL_BCC || '')
      .split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
    if (requiredBccList.length > 0) {
      const legal = detectLegalFlavor(bodyText, subject || '');
      if (legal.triggered) {
        let bccStr = '';
        for (let i = 0; i < flagArgs.length; i++) {
          if ((flagArgs[i] === '--bcc' || flagArgs[i] === '--bccAdd') && flagArgs[i + 1]) {
            bccStr += ',' + flagArgs[i + 1];
            i++;
          }
        }
        const bccLower = bccStr.toLowerCase();
        const missingAddrs = requiredBccList.filter(addr => !bccLower.includes(addr));
        if (missingAddrs.length > 0) {
          const missingStr = missingAddrs.join(', ');
          const existingBcc = bccStr.replace(/^,/, '').trim() || (process.env.GW_DEFAULT_BCC || '');
          const suggestedBcc = [existingBcc, ...missingAddrs].filter(Boolean).join(',');
          throw new Error(
            `${callerName}: LEGAL-FLAVORED EMAIL DETECTED (keyword: "${legal.keyword}" near: ${JSON.stringify(legal.context)}).\n` +
            `  Required BCC missing: ${missingStr}\n` +
            `  Add via --bcc "${suggestedBcc}"\n` +
            `  Or pass --skip-legal-bcc-check to override (rare; document why).`
          );
        }
      }
    }
  }

  return bodyText;
}

async function cmdGmailReplyDraft(threadId, bodyFile, flagArgs) {
  if (!threadId || !bodyFile) {
    console.error('usage: gmail-reply-draft <threadId> <bodyFile> [--bcc X] [--to X] [--cc X] [--subject X]');
    process.exit(1);
  }
  const flags = { attach: [] };
  for (let i = 0; i < flagArgs.length; i++) {
    const a = flagArgs[i];
    if (a === '--bcc') flags.bcc = flagArgs[++i];
    else if (a === '--to') flags.to = flagArgs[++i];
    else if (a === '--cc') flags.cc = flagArgs[++i];
    else if (a === '--subject') flags.subject = flagArgs[++i];
    else if (a === '--attach') flags.attach.push(flagArgs[++i]);
  }
  const gmail = await buildService('gmail', 'v1');

  // load body
  let bodyText = fs.readFileSync(bodyFile, 'utf8').trim();

  // Shared validation: em-dash check, closing check, legal-BCC gate. Subject
  // passed for legal-keyword scan; flags.subject captures the --subject override
  // (thread subject not yet fetched at this point).
  bodyText = validateDraftBody(bodyText, flagArgs, 'gmail-reply-draft', flags.subject || '');

  // Prior-outbound check: before staging, glance at recent sent mail to the
  // thread's reply-target. If we sent something else to them in the last 48h
  // on a DIFFERENT thread, the current draft is likely redundant or
  // contradictory. Override via --skip-prior-outbound-check.
  if (!flagArgs.includes('--skip-prior-outbound-check')) {
    // Determine the primary reply-target: use --to if provided, else the From of last message
    const replyTarget = (flags.to ? parseAddressList(flags.to)[0] : null)
      || (await gmail.users.threads.get({ userId: 'me', id: threadId, format: 'metadata', metadataHeaders: ['From'] }))
        .data.messages.slice(-1)[0].payload.headers.find((h) => h.name === 'From')?.value;
    if (replyTarget) {
      const prior = await checkPriorOutboundToRecipient(gmail, replyTarget, 48);
      // Only flag if the most recent prior outbound is on a DIFFERENT thread.
      if (prior && prior.messageId) {
        const priorMsg = await gmail.users.messages.get({ userId: 'me', id: prior.messageId, format: 'minimal' });
        if (priorMsg.data.threadId !== threadId) {
          throw new Error(
            `gmail-reply-draft: PRIOR OUTBOUND DETECTED to ${replyTarget} on a different thread within 48h.\n` +
            `  most-recent: ${prior.date} | "${prior.subject}"\n` +
            `  msgId: ${prior.messageId} | threadId: ${priorMsg.data.threadId}\n` +
            `  snippet: ${prior.snippet.slice(0, 200)}\n` +
            `Reconcile state before drafting. Pass --skip-prior-outbound-check to override.`
          );
        }
      }
    }
  }

  // fetch thread to find the most recent message (the one we reply to)
  const thread = await gmail.users.threads.get({ userId: 'me', id: threadId, format: 'full' });
  const messages = thread.data.messages || [];
  if (!messages.length) throw new Error('Thread has no messages: ' + threadId);
  const lastMsg = messages[messages.length - 1];
  const lastHeaders = lastMsg.payload.headers || [];
  const lastFrom = headerLookup(lastHeaders, 'From');
  const lastTo = headerLookup(lastHeaders, 'To');
  const lastCc = headerLookup(lastHeaders, 'Cc');
  const lastSubject = headerLookup(lastHeaders, 'Subject');
  const lastDate = headerLookup(lastHeaders, 'Date');
  const lastMessageId = headerLookup(lastHeaders, 'Message-ID') || headerLookup(lastHeaders, 'Message-Id');
  const lastRefs = headerLookup(lastHeaders, 'References');

  // identity
  const sendAsRes = await gmail.users.settings.sendAs.list({ userId: 'me' });
  const sendAs = (sendAsRes.data.sendAs || []).find((s) => s.isDefault) || (sendAsRes.data.sendAs || [])[0];
  if (!sendAs) throw new Error('No sendAs identity available');
  const myEmail = sendAs.sendAsEmail;
  const myDisplay = sendAs.displayName || '';
  const fromHeader = myDisplay ? `${myDisplay} <${myEmail}>` : myEmail;
  const signature = sendAs.signature || '';

  // Ownership pre-flight check (opt-in via GW_OWNERSHIP_CHECK=1):
  // When multiple humans on your own domain share inbox-ish workflow, count
  // outbound from each same-domain sender on this thread. If someone else has
  // more outbound than me, throw — they own the thread and a parallel draft
  // is probably a mistake. Override per-call via --skip-ownership-check.
  if (process.env.GW_OWNERSHIP_CHECK === '1' && !flagArgs.includes('--skip-ownership-check')) {
    const myDomainLc = (myEmail.split('@')[1] || '').toLowerCase();
    const senderCounts = {};
    for (const m of messages) {
      const fHeader = headerLookup(m.payload.headers || [], 'From');
      if (!fHeader) continue;
      const fAddr = ((fHeader.match(/<([^>]+)>/) || [null, fHeader])[1] || '').toLowerCase().trim();
      if (!fAddr.endsWith('@' + myDomainLc)) continue;
      senderCounts[fAddr] = (senderCounts[fAddr] || 0) + 1;
    }
    const sorted = Object.entries(senderCounts).sort((a, b) => b[1] - a[1]);
    if (sorted.length >= 1) {
      const [topAddr, topCount] = sorted[0];
      const myCount = senderCounts[myEmail.toLowerCase()] || 0;
      if (topAddr !== myEmail.toLowerCase() && topCount > myCount) {
        throw new Error(
          `gmail-reply-draft: ownership pre-flight failed. ${topAddr} has ${topCount} outbound on this thread vs your ${myCount}. ` +
            `Looks like ${topAddr.split('@')[0]} owns this thread. ` +
            `Pass --skip-ownership-check to override (e.g. they're OOO, explicit handoff, sender asked for you).`
        );
      }
    }
  }

  // to/cc derivation (reply-all minus self, domain-aware)
  // Anyone from my own domain is treated as internal (Cc by default).
  // Everyone else is external (To by default).
  // Keeps coworkers on the same domain out of the To line on reply-all.
  const myDomain = (myEmail.split('@')[1] || '').toLowerCase();
  const addressDomain = (addr) => {
    const m = addr.match(/<([^>]+)>/);
    const raw = (m ? m[1] : addr).toLowerCase();
    return (raw.split('@')[1] || '').trim();
  };
  const isMe = (addr) => addr.toLowerCase().includes(myEmail.toLowerCase());
  const isInternal = (addr) => addressDomain(addr) === myDomain;

  // gather all non-self participants from the last message (From + To + Cc)
  const seenKeys = new Set();
  const allParticipants = [];
  const addUnique = (addr) => {
    if (!addr) return;
    const key = (addr.match(/<([^>]+)>/) || [null, addr])[1].toLowerCase();
    if (seenKeys.has(key)) return;
    if (isMe(addr)) return;
    seenKeys.add(key);
    allParticipants.push(addr);
  };
  addUnique(lastFrom);
  for (const a of parseAddressList(lastTo)) addUnique(a);
  for (const a of parseAddressList(lastCc)) addUnique(a);

  let toList, ccList;
  if (flags.to) {
    toList = parseAddressList(flags.to);
    if (flags.cc !== undefined) {
      ccList = parseAddressList(flags.cc);
    } else {
      // auto-fill Cc with everyone not in the explicit To
      const toKeys = new Set(
        toList.map((a) => (a.match(/<([^>]+)>/) || [null, a])[1].toLowerCase())
      );
      ccList = allParticipants.filter((a) => {
        const k = (a.match(/<([^>]+)>/) || [null, a])[1].toLowerCase();
        return !toKeys.has(k);
      });
    }
  } else if (flags.cc !== undefined) {
    ccList = parseAddressList(flags.cc);
    const ccKeys = new Set(
      ccList.map((a) => (a.match(/<([^>]+)>/) || [null, a])[1].toLowerCase())
    );
    toList = allParticipants.filter((a) => {
      const k = (a.match(/<([^>]+)>/) || [null, a])[1].toLowerCase();
      return !ccKeys.has(k);
    });
  } else {
    // domain-aware auto split
    toList = allParticipants.filter((a) => !isInternal(a));
    ccList = allParticipants.filter((a) => isInternal(a));
    // edge case: if the only participants are internal (talking to coworkers), keep them in To
    if (toList.length === 0 && ccList.length > 0) {
      toList = ccList;
      ccList = [];
    }
  }
  const bccList = flags.bcc ? parseAddressList(flags.bcc) : [];

  // subject
  let subject = flags.subject || lastSubject || '';
  if (subject && !/^re:/i.test(subject)) subject = 'Re: ' + subject;

  // threading headers
  const inReplyTo = lastMessageId;
  const references = lastRefs ? `${lastRefs} ${lastMessageId}`.trim() : lastMessageId;

  // previous body for quoting: prefer HTML, fall back to plain text
  const prevHtml = collectHtml(lastMsg.payload);
  const prevText = collectPlainText(lastMsg.payload) || lastMsg.snippet || '';
  // trim plain-text fallback if huge
  const prevTextTrimmed =
    prevText.length > 4000 ? prevText.slice(0, 4000) + '\n[... quoted content trimmed ...]' : prevText;

  // build bodies — if bodyText is HTML, derive a plain-text version for the text/plain alternative
  const plainBodyText = looksLikeHtml(bodyText)
    ? bodyText.replace(/<br\s*\/?>/gi, '\n').replace(/<\/(div|p|h[1-6]|li|tr)>/gi, '\n').replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\n{3,}/g, '\n\n').trim()
    : bodyText;
  const plainBody =
    plainBodyText +
    '\n\n' +
    (signature ? signature.replace(/<[^>]+>/g, '') + '\n\n' : '') +
    buildGmailQuoteText(lastDate, lastFrom, prevTextTrimmed);

  const htmlBody =
    '<div dir="ltr">' +
    textToHtmlParagraphs(bodyText) +
    (signature ? `<br>${signature}<br>` : '<br>') +
    buildGmailQuoteHtml(lastDate, lastFrom, prevHtml, prevTextTrimmed) +
    '</div>';

  const mime = buildMimeReply({
    fromHeader,
    toList,
    ccList,
    bccList,
    subject,
    inReplyTo,
    references,
    plainBody,
    htmlBody,
    attachments: flags.attach,
  });
  const raw = toBase64Url(mime);

  const draftRes = await gmail.users.drafts.create({
    userId: 'me',
    requestBody: {
      message: {
        raw,
        threadId,
      },
    },
  });

  const draftId = draftRes.data.id;
  const messageId = draftRes.data.message.id;
  const directUrl = `https://mail.google.com/mail/u/0/#drafts/${messageId}`;

  await verifyStagedDraft(gmail, { draftId, messageId });

  console.log(
    JSON.stringify(
      {
        ok: true,
        draftId,
        messageId,
        threadId,
        to: toList,
        cc: ccList,
        bcc: bccList,
        subject,
        directUrl,
      },
      null,
      2
    )
  );
}

// Prior-outbound check: search recent sent messages to a given recipient.
// Guards against
// duplicate / contradictory drafts when triggered by stale self-notes.
async function checkPriorOutboundToRecipient(gmail, recipientAddr, hoursWindow = 48, opts = {}) {
  if (!recipientAddr) return null;
  const m = recipientAddr.match(/<([^>]+)>/);
  const addr = ((m ? m[1] : recipientAddr) || '').trim().toLowerCase();
  if (!addr || !addr.includes('@')) return null;
  // Skip internal recipients. GW_INTERNAL_DOMAINS is a comma-separated list of
  // domains that are considered internal (frequent cross-talk, shouldn't trip
  // duplicate-send guardrails). opts.includeInternal=true bypasses the skip,
  // used by new-draft callers that want to catch redundant fresh-thread sends.
  const internalDomains = (process.env.GW_INTERNAL_DOMAINS || '')
    .split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  if (internalDomains.length && !opts.includeInternal) {
    const re = new RegExp(`@(${internalDomains.map(d => d.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})$`, 'i');
    if (re.test(addr)) return null;
  }
  const days = Math.max(1, Math.ceil(hoursWindow / 24));
  const r = await gmail.users.messages.list({
    userId: 'me',
    q: `to:${addr} newer_than:${days}d in:sent`,
    maxResults: 5,
  });
  const messages = r.data.messages || [];
  if (!messages.length) return null;
  const meta = await gmail.users.messages.get({ userId: 'me', id: messages[0].id, format: 'metadata', metadataHeaders: ['Subject', 'Date'] });
  const headers = (meta.data.payload?.headers || []);
  return {
    messageId: messages[0].id,
    subject: (headers.find((h) => h.name === 'Subject') || {}).value || '',
    date: (headers.find((h) => h.name === 'Date') || {}).value || '',
    snippet: meta.data.snippet || '',
    matchCount: messages.length,
  };
}

// New-draft command: stage a fresh-thread Gmail draft (no existing threadId).
// Bakes in the same checks as gmail-reply-draft via shared validateDraftBody():
// PLUS a prior-outbound check so we don't accidentally duplicate a recent send.
async function cmdGmailNewDraft(toAddr, subjectArg, bodyFile, flagArgs = []) {
  if (!toAddr || !subjectArg || !bodyFile) {
    console.error('usage: gmail-new-draft <toAddr> <subject> <bodyFile> [--cc X] [--bcc X] [--skip-thanks-check] [--skip-prior-outbound-check] [--skip-claude-marker]');
    process.exit(1);
  }
  const flags = {};
  for (let i = 0; i < flagArgs.length; i++) {
    const a = flagArgs[i];
    if (a === '--cc') flags.cc = flagArgs[++i];
    else if (a === '--bcc') flags.bcc = flagArgs[++i];
  }
  const gmail = await buildService('gmail', 'v1');

  // Prior-outbound check (default ON). includeInternal:true catches redundant
  // fresh-thread sends to GW_INTERNAL_DOMAINS recipients.
  if (!flagArgs.includes('--skip-prior-outbound-check')) {
    const prior = await checkPriorOutboundToRecipient(gmail, toAddr, 48, { includeInternal: true });
    if (prior) {
      throw new Error(
        `gmail-new-draft: PRIOR OUTBOUND DETECTED to ${toAddr} within 48h.\n` +
        `  most-recent: ${prior.date} | "${prior.subject}"\n` +
        `  msgId: ${prior.messageId}\n` +
        `  snippet: ${prior.snippet.slice(0, 200)}\n` +
        `Reconcile state before drafting. Pass --skip-prior-outbound-check to override (${prior.matchCount} match${prior.matchCount > 1 ? 'es' : ''} in window).`
      );
    }
  }

  let bodyText = fs.readFileSync(bodyFile, 'utf8').trim();

  // Shared validation: em-dash check, closing check, legal-BCC gate. Subject
  // passed so legal-keyword scan covers it too.
  bodyText = validateDraftBody(bodyText, flagArgs, 'gmail-new-draft', subjectArg);

  // Identity + signature
  const sendAsRes = await gmail.users.settings.sendAs.list({ userId: 'me' });
  const sendAs = (sendAsRes.data.sendAs || []).find((s) => s.isDefault) || (sendAsRes.data.sendAs || [])[0];
  const myEmail = sendAs.sendAsEmail;
  const myDisplay = sendAs.displayName || '';
  const fromHeader = myDisplay ? `${myDisplay} <${myEmail}>` : myEmail;
  const sig = sendAs.signature || '';

  // HTML body: wrap paragraphs cleanly via textToHtmlParagraphs (matches gmail-reply-draft).
  // Naive split('\n').join('<br>') over-spaces paragraphs by emitting 3 <br> per blank line.
  const html = textToHtmlParagraphs(bodyText) + (sig ? `<br>${sig}<br>` : '<br>');

  const subjectEnc = encodeHeaderRfc2047(subjectArg);
  const headers = [
    `From: ${fromHeader}`,
    `To: ${toAddr}`,
    flags.cc ? `Cc: ${flags.cc}` : null,
    flags.bcc ? `Bcc: ${flags.bcc}` : null,
    `Subject: ${subjectEnc}`,
    'Mime-Version: 1.0',
    'Content-Type: text/html; charset="UTF-8"',
    'Content-Transfer-Encoding: 8bit',
  ].filter(Boolean).join('\r\n');
  const raw = toBase64Url(headers + '\r\n\r\n' + html);

  const draftRes = await gmail.users.drafts.create({
    userId: 'me',
    requestBody: { message: { raw } },
  });
  await verifyStagedDraft(gmail, { draftId: draftRes.data.id, messageId: draftRes.data.message.id });
  const out = {
    ok: true,
    draftId: draftRes.data.id,
    messageId: draftRes.data.message.id,
    to: toAddr,
    cc: flags.cc || null,
    bcc: flags.bcc || null,
    subject: subjectArg,
    directUrl: `https://mail.google.com/mail/u/0/#drafts/${draftRes.data.message.id}`,
  };
  console.log(JSON.stringify(out, null, 2));
  return out;
}

async function main() {
  const [, , cmd, ...args] = process.argv;
  if (!cmd || cmd === '--help' || cmd === '-h') {
    console.error(
      'Subcommands: whoami | gmail-search <q> [n] | gmail-oldest <q> | gmail-get <id> | gmail-thread <threadId> [--check-reply-from <email>] | gmail-signature | gmail-reply-draft <threadId> <bodyFile> [flags] | drive-list [n]'
    );
    process.exit(1);
  }
  try {
    switch (cmd) {
      case 'whoami':
        await cmdWhoami();
        break;
      case 'gmail-search':
        await cmdGmailSearch(args[0] || '', args[1]);
        break;
      case 'gmail-oldest':
        await cmdGmailOldest(args[0] || '');
        break;
      case 'gmail-get':
        await cmdGmailGet(args[0]);
        break;
      case 'gmail-thread':
        await cmdGmailThread(args[0], args.slice(1));
        break;
      case 'gmail-signature':
        await cmdGmailSignature();
        break;
      case 'gmail-reply-draft':
        await cmdGmailReplyDraft(args[0], args[1], args.slice(2));
        break;
      case 'gmail-new-draft':
        await cmdGmailNewDraft(args[0], args[1], args[2], args.slice(3));
        break;
      case 'gmail-send-draft':
        await cmdGmailSendDraft(args[0]);
        break;
      case 'gmail-thread-label-sync':
        await cmdGmailThreadLabelSync(args[0]);
        break;
      case 'gmail-thread-label-swap':
        await cmdGmailThreadLabelSwap(args[0], args[1], args[2]);
        break;
      case 'gmail-thread-bury':
        await cmdGmailThreadBury(args[0]);
        break;
      case 'drive-list':
        await cmdDriveList(args[0]);
        break;
      default:
        console.error('Unknown command:', cmd);
        process.exit(1);
    }
  } catch (e) {
    console.error('ERROR:', e.message);
    if (e.response && e.response.data) {
      console.error(JSON.stringify(e.response.data, null, 2));
    }
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

// markProcessedWithLog — apply a "processed" label with an audit trail.
// Use this wrapper instead of raw threads.modify so every state change is
// logged with reason + actor + context.
//
// Mark a thread "processed" by adding a configurable label and writing an
// audit log entry. `reason` is a free-form slug (kebab/snake) describing why,
// `extra` is an optional context object (vendor, draftId, taskId, etc.).
//
// Configure via env:
//   GW_PROCESSED_LABEL  (default "processed") — Gmail label to apply
//   GW_PROCESSED_LOG    (default "_processed_log.jsonl" alongside this file)
const PROCESSED_REASON_RE = /^[a-z0-9][a-z0-9_-]{1,63}$/;
async function markProcessedWithLog(gmail, threadId, reason, extra) {
  if (typeof reason !== 'string' || !PROCESSED_REASON_RE.test(reason)) {
    throw new Error(
      'markProcessedWithLog: invalid reason ' + JSON.stringify(reason) +
        '. Must match ' + PROCESSED_REASON_RE.toString() + ' (lowercase slug).'
    );
  }
  const labelName = process.env.GW_PROCESSED_LABEL || 'processed';
  const labels = (await gmail.users.labels.list({ userId: 'me' })).data.labels || [];
  const lbl = labels.find((l) => l.name === labelName);
  if (!lbl) throw new Error(`markProcessedWithLog: label "${labelName}" not found`);
  let subject = '';
  try {
    const t = await gmail.users.threads.get({
      userId: 'me', id: threadId, format: 'metadata', metadataHeaders: ['Subject'],
    });
    const last = t.data.messages[t.data.messages.length - 1];
    subject = (last.payload.headers.find((h) => h.name === 'Subject') || {}).value || '';
  } catch {}
  await gmail.users.threads.modify({
    userId: 'me', id: threadId,
    requestBody: { addLabelIds: [lbl.id] },
  });
  const entry = {
    ts: new Date().toISOString(),
    thread_id: threadId,
    subject,
    actor: process.argv[1] ? path.basename(process.argv[1]) : 'unknown',
    reason,
    extra: extra || null,
  };
  const logPath = process.env.GW_PROCESSED_LOG ||
    path.join(HERE, '_processed_log.jsonl');
  fs.appendFileSync(logPath, JSON.stringify(entry) + '\n');
  return entry;
}

module.exports = { buildService, getAuthClient, SCOPES, encodeHeaderRfc2047, markProcessedWithLog, checkPriorOutboundToRecipient, assertNoRecentDuplicateOutbound };
