const express = require('express');
const path = require('path');
const { spawn } = require('child_process');
const { telegramAuth, requireTelegramRole } = require('../middleware/telegramAuth');

const router = express.Router();
const reportFile = path.join(__dirname, '..', 'load-test-report.html');
let loadTestRunning = false;

router.post('/load-test', telegramAuth, requireTelegramRole('admin'), async (req, res) => {
  if (loadTestRunning) {
    return res.status(409).json({ error: 'Load test already running' });
  }

  loadTestRunning = true;
  const scriptPath = path.join(__dirname, '..', 'load-test.js');
  const child = spawn(process.execPath, [scriptPath], {
    cwd: path.join(__dirname, '..'),
    env: process.env,
  });

  let stdout = '';
  let stderr = '';

  child.stdout.on('data', (chunk) => {
    stdout += chunk.toString();
  });

  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString();
  });

  child.on('close', (code) => {
    loadTestRunning = false;
  });

  const result = await new Promise((resolve) => {
    child.on('close', (code) => {
      resolve({ code, stdout, stderr });
    });
  });

  if (result.code !== 0) {
    return res.status(500).json({
      error: 'Load test failed',
      code: result.code,
      stdout: result.stdout,
      stderr: result.stderr,
    });
  }

  return res.json({
    message: 'Load test completed successfully',
    reportUrl: '/api/admin/load-test-report',
    stdout: result.stdout,
    stderr: result.stderr,
  });
});

router.get('/load-test-report', telegramAuth, requireTelegramRole('admin'), (req, res) => {
  res.download(reportFile, 'load-test-report.html', (err) => {
    if (err) {
      console.error('[admin/load-test-report] download error', err);
      if (!res.headersSent) {
        return res.status(500).json({ error: 'Unable to download report' });
      }
    }
  });
});

module.exports = router;
