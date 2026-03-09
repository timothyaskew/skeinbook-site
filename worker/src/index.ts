/**
 * SkeinBook Beta Gate — Cloudflare Worker
 *
 * POST /api/download  { betaKey, platform }
 *   → validates key against Supabase beta_users table
 *   → generates a Wasabi S3 presigned download URL (15 min)
 *   → increments download_count, records last_download + platform
 *   → returns { url, filename }
 *
 * All secrets are bound via wrangler.toml / `wrangler secret put`.
 */

import {
  S3Client,
  GetObjectCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

// ── Types ────────────────────────────────────────────────────────────

interface Env {
  SUPABASE_URL: string;
  SUPABASE_SERVICE_KEY: string;
  WASABI_ACCESS_KEY: string;
  WASABI_SECRET_KEY: string;
  WASABI_BUCKET: string;
  WASABI_REGION: string;
  WASABI_ENDPOINT: string;
}

interface DownloadRequest {
  betaKey: string;
  platform: 'windows' | 'mac-x64' | 'mac-arm64' | 'linux';
}

// ── Current release manifest ─────────────────────────────────────────
// Update these when you push a new build to Wasabi.

const CURRENT_VERSION = '0.1.0';

const PLATFORM_FILES: Record<string, { key: string; filename: string }> = {
  windows: {
    key: `installers/SkeinBook-${CURRENT_VERSION}-windows.exe`,
    filename: `SkeinBook Setup ${CURRENT_VERSION}.exe`,
  },
  'mac-x64': {
    key: `installers/SkeinBook-${CURRENT_VERSION}-mac-x64.zip`,
    filename: `SkeinBook-${CURRENT_VERSION}-x64.zip`,
  },
  'mac-arm64': {
    key: `installers/SkeinBook-${CURRENT_VERSION}-mac-arm64.zip`,
    filename: `SkeinBook-${CURRENT_VERSION}-arm64.zip`,
  },
  linux: {
    key: `installers/SkeinBook-${CURRENT_VERSION}-linux.AppImage`,
    filename: `SkeinBook-${CURRENT_VERSION}.AppImage`,
  },
};

// ── CORS helpers ─────────────────────────────────────────────────────

const ALLOWED_ORIGINS = [
  'https://skeinbook.app',
  'https://www.skeinbook.app',
  'http://localhost:8788',       // local dev
];

function corsHeaders(origin: string | null): Record<string, string> {
  const allowed = origin && ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin': allowed,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
  };
}

// ── Supabase helpers ─────────────────────────────────────────────────

async function lookupBetaKey(
  betaKey: string,
  env: Env,
): Promise<{ id: string; email: string } | null> {
  const url = `${env.SUPABASE_URL}/rest/v1/beta_users?beta_key=eq.${encodeURIComponent(betaKey)}&select=id,email`;
  const res = await fetch(url, {
    headers: {
      apikey: env.SUPABASE_SERVICE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`,
    },
  });
  if (!res.ok) return null;
  const rows = (await res.json()) as { id: string; email: string }[];
  return rows.length > 0 ? rows[0] : null;
}

async function recordDownload(
  userId: string,
  platform: string,
  env: Env,
): Promise<void> {
  const url = `${env.SUPABASE_URL}/rest/v1/beta_users?id=eq.${userId}`;
  // Use RPC-style PATCH to increment download_count
  // Supabase REST doesn't support increment natively, so we fetch + patch
  const fetchUrl = `${env.SUPABASE_URL}/rest/v1/beta_users?id=eq.${userId}&select=download_count`;
  const current = await fetch(fetchUrl, {
    headers: {
      apikey: env.SUPABASE_SERVICE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`,
    },
  });
  const rows = (await current.json()) as { download_count: number }[];
  const count = rows.length > 0 ? rows[0].download_count : 0;

  await fetch(url, {
    method: 'PATCH',
    headers: {
      apikey: env.SUPABASE_SERVICE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'return=minimal',
    },
    body: JSON.stringify({
      download_count: count + 1,
      last_download: new Date().toISOString(),
      platform,
    }),
  });
}

// ── Wasabi presigned URL ─────────────────────────────────────────────

async function generatePresignedUrl(
  fileKey: string,
  filename: string,
  env: Env,
): Promise<string> {
  const client = new S3Client({
    region: env.WASABI_REGION,
    endpoint: env.WASABI_ENDPOINT,
    credentials: {
      accessKeyId: env.WASABI_ACCESS_KEY,
      secretAccessKey: env.WASABI_SECRET_KEY,
    },
    forcePathStyle: true, // Required for Wasabi
  });

  const command = new GetObjectCommand({
    Bucket: env.WASABI_BUCKET,
    Key: fileKey,
    ResponseContentDisposition: `attachment; filename="${filename}"`,
  });

  return getSignedUrl(client, command, { expiresIn: 900 }); // 15 minutes
}

// ── Request handler ──────────────────────────────────────────────────

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const origin = request.headers.get('Origin');
    const cors = corsHeaders(origin);

    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors });
    }

    const url = new URL(request.url);

    // Only handle POST /api/download
    if (url.pathname !== '/api/download' || request.method !== 'POST') {
      return new Response(JSON.stringify({ error: 'Not found' }), {
        status: 404,
        headers: { ...cors, 'Content-Type': 'application/json' },
      });
    }

    try {
      const body = (await request.json()) as DownloadRequest;

      // Validate input
      if (!body.betaKey || typeof body.betaKey !== 'string') {
        return new Response(JSON.stringify({ error: 'Missing betaKey' }), {
          status: 400,
          headers: { ...cors, 'Content-Type': 'application/json' },
        });
      }

      const platform = body.platform || 'windows';
      const platformFile = PLATFORM_FILES[platform];
      if (!platformFile) {
        return new Response(JSON.stringify({ error: 'Invalid platform' }), {
          status: 400,
          headers: { ...cors, 'Content-Type': 'application/json' },
        });
      }

      // 1. Look up beta key
      const user = await lookupBetaKey(body.betaKey.trim(), env);
      if (!user) {
        return new Response(
          JSON.stringify({ error: 'Invalid beta key. Check your invite and try again.' }),
          {
            status: 401,
            headers: { ...cors, 'Content-Type': 'application/json' },
          },
        );
      }

      // 2. Generate presigned download URL
      const presignedUrl = await generatePresignedUrl(
        platformFile.key,
        platformFile.filename,
        env,
      );

      // 3. Record the download (fire-and-forget, don't block response)
      void recordDownload(user.id, platform, env);

      // 4. Return the URL
      return new Response(
        JSON.stringify({
          url: presignedUrl,
          filename: platformFile.filename,
          version: CURRENT_VERSION,
        }),
        {
          status: 200,
          headers: { ...cors, 'Content-Type': 'application/json' },
        },
      );
    } catch (err) {
      console.error('Download handler error:', err);
      return new Response(
        JSON.stringify({ error: 'Internal server error' }),
        {
          status: 500,
          headers: { ...cors, 'Content-Type': 'application/json' },
        },
      );
    }
  },
};
