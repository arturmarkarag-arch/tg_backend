'use strict';

const { S3Client, PutObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');

// Shared Cloudflare R2 client + helpers. Lets routes issue presigned PUT URLs
// (so the browser uploads straight to R2, bypassing our server) and delete
// objects (e.g. one-shot vision query photos after OpenAI has read them).
const s3 = new S3Client({
  region:   process.env.R2_REGION || 'auto',
  endpoint: process.env.R2_ENDPOINT,
  credentials: {
    accessKeyId:     process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
  forcePathStyle: true,
});

async function presignPutUrl(key, contentType = 'image/jpeg', expiresIn = 300) {
  const cmd = new PutObjectCommand({ Bucket: process.env.R2_BUCKET_NAME, Key: key, ContentType: contentType });
  return getSignedUrl(s3, cmd, { expiresIn });
}

// Best-effort delete — never throws (callers fire it after the work is done).
async function deleteObject(key) {
  if (!key) return;
  try {
    await s3.send(new DeleteObjectCommand({ Bucket: process.env.R2_BUCKET_NAME, Key: key }));
  } catch (err) {
    console.error('[r2] delete failed for', key, err.message);
  }
}

function publicUrl(key) {
  return `${(process.env.R2_PUBLIC_URL || '').replace(/\/$/, '')}/${String(key).replace(/^\//, '')}`;
}

module.exports = { s3, presignPutUrl, deleteObject, publicUrl };
