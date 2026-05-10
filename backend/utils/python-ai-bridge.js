const config = require('../config');
const http = require('http');

const PYTHON_AI_HOST = process.env.PYTHON_AI_HOST || 'localhost';
const PYTHON_AI_PORT = process.env.PYTHON_AI_PORT || 5000;

let pythonAiAvailable = false;

async function checkPythonAI() {
  return new Promise((resolve) => {
    const req = http.get(`http://${PYTHON_AI_HOST}:${PYTHON_AI_PORT}/health`, (res) => {
      pythonAiAvailable = res.statusCode === 200;
      resolve(pythonAiAvailable);
    });
    req.on('error', () => {
      pythonAiAvailable = false;
      resolve(false);
    });
    req.setTimeout(3000, () => {
      req.destroy();
      pythonAiAvailable = false;
      resolve(false);
    });
  });
}

async function analyzeWithPython(tokenAddress, tokenData, historicalTokens = []) {
  if (!pythonAiAvailable) {
    await checkPythonAI();
  }

  if (!pythonAiAvailable) {
    return null;
  }

  return new Promise((resolve, reject) => {
    const postData = JSON.stringify({
      token_address: tokenAddress,
      token_data: tokenData,
      historical_tokens: historicalTokens
    });

    const options = {
      hostname: PYTHON_AI_HOST,
      port: PYTHON_AI_PORT,
      path: '/analyze',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData)
      },
      timeout: 10000
    };

    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        try {
          const result = JSON.parse(data);
          resolve(result);
        } catch (e) {
          reject(e);
        }
      });
    });

    req.on('error', (e) => {
      pythonAiAvailable = false;
      reject(e);
    });

    req.on('timeout', () => {
      req.destroy();
      pythonAiAvailable = false;
      reject(new Error('Python AI timeout'));
    });

    req.write(postData);
    req.end();
  });
}

async function getPythonAIStatus() {
  const available = await checkPythonAI();
  return {
    available,
    host: PYTHON_AI_HOST,
    port: PYTHON_AI_PORT
  };
}

async function startPythonAIServer() {
  const { spawn } = require('child_process');
  const path = require('path');

  const pythonScript = path.join(__dirname, '../python/ai_agent.py');

  console.log('[PythonAI] Starting AI agent...');

  const pythonProcess = spawn('python', [pythonScript, 'serve'], {
    cwd: path.join(__dirname, '../python'),
    stdio: ['ignore', 'pipe', 'pipe']
  });

  pythonProcess.stdout.on('data', (data) => {
    console.log('[PythonAI]', data.toString().trim());
  });

  pythonProcess.stderr.on('data', (data) => {
    console.error('[PythonAI Error]', data.toString().trim());
  });

  pythonProcess.on('close', (code) => {
    console.log(`[PythonAI] Process exited with code ${code}`);
    pythonAiAvailable = false;
  });

  // Wait for server to be ready
  await new Promise(r => setTimeout(r, 3000));
  await checkPythonAI();

  if (pythonAiAvailable) {
    console.log('[PythonAI] Agent ready and listening');
  } else {
    console.log('[PythonAI] Warning: Agent not responding');
  }

  return pythonProcess;
}

module.exports = {
  analyzeWithPython,
  getPythonAIStatus,
  startPythonAIServer,
  checkPythonAI
};