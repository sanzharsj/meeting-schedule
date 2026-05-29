// 매일 한국 시간 15:00 (UTC 06:00)에 Vercel Cron이 호출.
// 브라우저 미접속 상태에서도 자동 리마인더 메일을 발송한다.
// 데이터 소스는 클라이언트와 동일한 Vercel Blob.

import { put, list } from '@vercel/blob';

const BLOB_PATH = 'meeting-schedule-data.json';
const SMTP_API = 'https://smtp-api-rust.vercel.app/api/send';
const VERCEL_URL = 'https://meeting-schedule-rho.vercel.app';

const CITY_ROWS = [
  { key: 'kr', label: '본사(서울)' },
  { key: 'kz', label: 'OHKZ(알마티)' },
  { key: 'us', label: 'OHUS(LA)' },
  { key: 'vn', label: 'OHVN(하노이)' },
];

function escHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function fmtHM(hm) { const [h, m] = hm.split(':'); return `${h}시 ${m}분`; }
function fmtYMD(ms, tz) {
  return new Intl.DateTimeFormat('ko-KR', { timeZone: tz, year: 'numeric', month: 'long', day: 'numeric' }).format(new Date(ms));
}
function meetingMs(e) {
  return new Date(e.koreaDate + 'T' + e.koreaTime + ':00+09:00').getTime();
}
function getWeekLabel(koreaDate) {
  const [yr, mo, dy] = koreaDate.split('-').map(Number);
  const d = new Date(Date.UTC(yr, mo - 1, dy));
  const dow = d.getUTCDay();
  const daysToMon = dow === 0 ? 6 : dow - 1;
  const monDay = dy - daysToMon;
  if (monDay >= 1) return `${yr}년 ${mo}월 ${Math.ceil(monDay / 7)}주차`;
  const prev = new Date(Date.UTC(yr, mo - 1, monDay));
  return `${prev.getUTCFullYear()}년 ${prev.getUTCMonth() + 1}월 ${Math.ceil(prev.getUTCDate() / 7)}주차`;
}

function buildMailContent(entry) {
  const subject = `${getWeekLabel(entry.koreaDate)} 주간회의 공지`;
  const [yr, mo, dy] = entry.koreaDate.split('-').map(Number);
  const [hr, mn] = entry.koreaTime.split(':').map(Number);
  const koreaMs = Date.UTC(yr, mo - 1, dy, hr - 9, mn);

  const cityMap = Object.fromEntries((entry.cities || []).map(c => [c.key, c]));
  const scheduleLines = CITY_ROWS.map(r => {
    const c = cityMap[r.key];
    if (!c) return null;
    return `${r.label} : ${fmtYMD(koreaMs, c.tz)} ${fmtHM(c.startT)} ~ ${fmtHM(c.endT)}`;
  }).filter(Boolean);

  const P = 'margin:0;line-height:1.7;';
  const BLANK = `<p style="${P}">&nbsp;</p>`;
  const infoLines = [
    entry.link ? `<p style="${P}">링크 : <a href="${escHtml(entry.link)}" style="color:#3b5bdb;word-break:break-all;">${escHtml(entry.link)}</a></p>` : '',
    entry.addr ? `<p style="${P}">회의 ID : ${escHtml(entry.addr)}</p>` : '',
    entry.pw ? `<p style="${P}">암호 : ${escHtml(entry.pw)}</p>` : '',
  ].filter(Boolean).join('\n');

  const html = `<!DOCTYPE html><html><body style="margin:0;padding:20px;background:#f0f2f5;font-family:'Malgun Gothic','Apple SD Gothic Neo',Arial,sans-serif;color:#1a1a2e;font-size:14px;line-height:1.7;">
    <div style="max-width:680px;margin:0 auto;background:#ffffff;padding:28px 28px 24px 28px;border-radius:12px;">
      <p style="${P}">안녕하세요.</p>
      <p style="${P}">검사지원본부 회의 일정 안내 드립니다.</p>
      ${BLANK}
      ${scheduleLines.map(l => `<p style="${P}">${escHtml(l)}</p>`).join('\n')}
      ${BLANK}
      ${infoLines}
      ${BLANK}
      <p style="${P}"><span style="color:#d32f2f;font-weight:700;">회의 전체 일정 : </span><a href="${VERCEL_URL}" style="color:#d32f2f;font-weight:700;text-decoration:underline;">${VERCEL_URL}</a></p>
      ${BLANK}
      <p style="${P}">감사합니다.</p>
    </div>
  </body></html>`;

  const textLines = [
    '안녕하세요.',
    '검사지원본부 회의 일정 안내 드립니다.',
    '',
    ...scheduleLines,
    '',
    entry.link ? `링크 : ${entry.link}` : null,
    entry.addr ? `회의 ID : ${entry.addr}` : null,
    entry.pw ? `암호 : ${entry.pw}` : null,
    '',
    `회의 전체 일정 : ${VERCEL_URL}`,
    '',
    '감사합니다.',
  ].filter(l => l !== null);
  const text = textLines.join('\n');

  return { subject, html, text };
}

// Blob 값은 문자열(원본 localStorage 값). 안전하게 JSON.parse.
function safeParse(v, fallback) {
  if (v == null) return fallback;
  if (typeof v !== 'string') return v;
  try { return JSON.parse(v); } catch { return fallback; }
}

async function readBlob() {
  const { blobs } = await list({ prefix: BLOB_PATH });
  const blob = blobs.find(b => b.pathname === BLOB_PATH);
  if (!blob) return {};
  const r = await fetch(blob.url, { cache: 'no-store' });
  return await r.json();
}

async function writeBlob(data) {
  await put(BLOB_PATH, JSON.stringify(data), {
    access: 'public',
    contentType: 'application/json',
    addRandomSuffix: false,
    allowOverwrite: true,
  });
}

export default async function handler(req, res) {
  const log = [];
  const sent = [];
  try {
    const raw = await readBlob();
    const entries = safeParse(raw.intlMeetingLog_v2, []);
    const rs = safeParse(raw.reminderSettings_v1, { days: 5, contacts: [] });
    const sentLog = safeParse(raw.reminderSentLog_v1, {});
    const schedule = safeParse(raw.reminderSchedule_v1, {});
    const smtp = safeParse(raw.smtpSettings_v1, {});

    if (!rs.contacts || rs.contacts.length === 0) {
      return res.status(200).json({ ok: true, skipped: 'no contacts' });
    }
    if (!smtp.server || !smtp.user || !smtp.pass) {
      return res.status(200).json({ ok: true, skipped: 'smtp not configured' });
    }

    const nowMs = Date.now();
    const windowMs = (rs.days || 5) * 24 * 3600 * 1000;
    const to = rs.contacts.map(c => c.email).filter(Boolean).join(',');

    const sorted = [...entries].sort((a, b) => meetingMs(a) - meetingMs(b));
    for (const e of sorted) {
      const mMs = meetingMs(e);
      if (mMs <= nowMs) continue;
      if (sentLog[e.id]) continue;
      if (schedule[e.id] === 'cancelled') continue;
      if (mMs - nowMs > windowMs) continue;

      const { subject, html, text } = buildMailContent(e);
      try {
        const r = await fetch(SMTP_API, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ smtp, to, subject, body: text, html, text, isHtml: true, contentType: 'text/html' }),
        });
        const data = await r.json().catch(() => ({}));
        if (!r.ok) {
          log.push({ id: e.id, error: data.error || `HTTP ${r.status}` });
          continue;
        }
        sentLog[e.id] = { sentAt: new Date().toISOString(), type: 'cron' };
        sent.push({ id: e.id, koreaDate: e.koreaDate, koreaTime: e.koreaTime });
      } catch (err) {
        log.push({ id: e.id, error: String(err) });
      }
    }

    if (sent.length > 0) {
      raw.reminderSentLog_v1 = JSON.stringify(sentLog);
      await writeBlob(raw);
    }

    return res.status(200).json({ ok: true, sent, errors: log, at: new Date().toISOString() });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e), sent, errors: log });
  }
}
