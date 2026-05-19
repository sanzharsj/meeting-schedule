import { put, list } from '@vercel/blob';

const BLOB_PATH = 'meeting-schedule-data.json';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  try {
    if (req.method === 'GET') {
      const { blobs } = await list({ prefix: BLOB_PATH });
      const blob = blobs.find(b => b.pathname === BLOB_PATH);
      if (!blob) {
        res.status(200).json({});
        return;
      }
      const r = await fetch(blob.url, { cache: 'no-store' });
      const text = await r.text();
      res.setHeader('Content-Type', 'application/json');
      res.status(200).send(text || '{}');
      return;
    }
    if (req.method === 'POST') {
      const body = (req.body && typeof req.body === 'object')
        ? req.body
        : JSON.parse(req.body || '{}');
      await put(BLOB_PATH, JSON.stringify(body), {
        access: 'public',
        contentType: 'application/json',
        addRandomSuffix: false,
        allowOverwrite: true,
      });
      res.status(200).json({ ok: true });
      return;
    }
    res.status(405).end();
  } catch (e) {
    res.status(500).json({ error: e.message || String(e) });
  }
}
