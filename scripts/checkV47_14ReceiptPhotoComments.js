'use strict';
const fs = require('fs');
const assert = require('assert');
const {
  normalizeReceiptPhotoMeta,
  labelPositionsFromPhotoMeta,
  photoCommentsText,
} = require('../utils/receiptPhotoMeta');

const schema = fs.readFileSync(require.resolve('../models/ReceiptItem'), 'utf8');
const routes = fs.readFileSync(require.resolve('../routes/receipts'), 'utf8');

let meta = normalizeReceiptPhotoMeta({
  comment: 'Legacy',
  commentPos: { x: 0.2, y: 0.7 },
});
assert.equal(meta.comments.length, 1);
assert.equal(meta.comments[0].text, 'Legacy');
assert.deepEqual(meta.comments[0].pos, { x: 0.2, y: 0.7 });
console.log('PASS: legacy single comment becomes first positioned comment');

meta = normalizeReceiptPhotoMeta({
  comments: [
    { id: 'a', text: 'Перший', pos: { x: 0, y: 1 } },
    { id: 'b', text: 'Другий', pos: { x: 0.8, y: 0.1 } },
  ],
});
assert.equal(meta.comments.length, 2);
assert.equal(meta.comment, 'Перший');
assert.deepEqual(meta.commentPos, { x: 0, y: 1 });
assert.equal(photoCommentsText(meta), 'Перший\nДругий');
const positions = labelPositionsFromPhotoMeta(meta);
assert.equal(positions.comments.length, 2);
assert.equal(positions.comments[0].x, 0);
assert.equal(positions.comments[0].y, 1);
console.log('PASS: multiple comments preserve independent normalized positions');

assert.ok(schema.includes('comments: { type: [PhotoCommentSchema], default: [] }'));
console.log('PASS: ReceiptItem schema persists comment array');
assert.ok(routes.includes('normalizeReceiptPhotoMeta(photoMeta)'));
assert.ok(routes.includes('normalizedPhotoMeta = normalizeReceiptPhotoMeta(rawPhotoMeta)'));
console.log('PASS: create/update routes normalize and persist photo comments');
console.log('V47.14 server receipt photo comments checks: PASS');
