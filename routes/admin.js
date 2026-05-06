const express = require('express');
const path = require('path');
const { spawn } = require('child_process');
const { telegramAuth, requireTelegramRole } = require('../middleware/telegramAuth');
const AppSetting = require('../models/AppSetting');
const { listOpenAIModels } = require('../openaiClient');

const router = express.Router();
const reportFile = path.join(__dirname, '..', 'load-test-report.html');
let loadTestRunning = false;
const OPENAI_MODEL_SETTING_KEY = 'openai.defaultModel';
const ORDERING_SCHEDULE_KEY = 'ordering.schedule';
const ORDERING_SCHEDULE_DEFAULTS = { openHour: 16, openMinute: 0, closeHour: 7, closeMinute: 30 };

async function getAppSetting(key, defaultValue = null) {
  const setting = await AppSetting.findOne({ key }).lean();
  return setting?.value ?? defaultValue;
}

async function setAppSetting(key, value) {
  const setting = await AppSetting.findOneAndUpdate(
    { key },
    { value },
    { upsert: true, new: true }
  ).lean();
  return setting.value;
}

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

router.get('/openai/models', telegramAuth, requireTelegramRole('admin'), async (req, res) => {
  try {
    const supportsImage = req.query.supportsImage === 'true';
    const models = await listOpenAIModels({ supportsImage });
    res.json(models);
  } catch (error) {
    console.error('[admin/openai/models] error', error.message || error);
    res.status(500).json({ error: error.message || 'Unable to fetch OpenAI models' });
  }
});

router.get('/openai/settings', telegramAuth, requireTelegramRole('admin'), async (req, res) => {
  try {
    const defaultModel = process.env.OPENAI_MODEL || 'gpt-5.4-nano';
    const selectedModel = await getAppSetting(OPENAI_MODEL_SETTING_KEY, defaultModel);
    res.json({ model: selectedModel });
  } catch (error) {
    console.error('[admin/openai/settings] error', error.message || error);
    res.status(500).json({ error: error.message || 'Unable to read OpenAI settings' });
  }
});

router.post('/openai/settings', telegramAuth, requireTelegramRole('admin'), async (req, res) => {
  try {
    const model = req.body?.model;
    if (!model || typeof model !== 'string') {
      return res.status(400).json({ error: 'Model is required' });
    }

    const models = await listOpenAIModels();
    if (!models.some((item) => item.id === model)) {
      return res.status(400).json({ error: 'Unknown or unsupported model' });
    }

    const selectedModel = await setAppSetting(OPENAI_MODEL_SETTING_KEY, model);
    res.json({ model: selectedModel });
  } catch (error) {
    console.error('[admin/openai/settings] error', error.message || error);
    res.status(500).json({ error: error.message || 'Unable to save OpenAI settings' });
  }
});

router.get('/ordering-schedule', telegramAuth, requireTelegramRole('admin'), async (req, res) => {
  try {
    const saved = await getAppSetting(ORDERING_SCHEDULE_KEY, ORDERING_SCHEDULE_DEFAULTS);
    res.json({ ...ORDERING_SCHEDULE_DEFAULTS, ...saved });
  } catch (error) {
    res.status(500).json({ error: error.message || 'Unable to read ordering schedule' });
  }
});

router.post('/ordering-schedule', telegramAuth, requireTelegramRole('admin'), async (req, res) => {
  try {
    const { openHour, openMinute, closeHour, closeMinute } = req.body;
    const toInt = (v, min, max) => {
      const n = parseInt(v, 10);
      if (isNaN(n) || n < min || n > max) throw new Error(`Value ${v} out of range [${min}, ${max}]`);
      return n;
    };
    const schedule = {
      openHour:    toInt(openHour,    0, 23),
      openMinute:  toInt(openMinute,  0, 59),
      closeHour:   toInt(closeHour,   0, 23),
      closeMinute: toInt(closeMinute, 0, 59),
    };
    const saved = await setAppSetting(ORDERING_SCHEDULE_KEY, schedule);
    res.json(saved);
  } catch (error) {
    res.status(400).json({ error: error.message || 'Invalid schedule data' });
  }
});

module.exports = router;
