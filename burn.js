// Cycle - Automated Jupiter Swap + Burn Bot with Fancy Logs

const {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction
} = require('@solana/web3.js');
const {
  getAssociatedTokenAddress,
  createBurnInstruction,
  getAccount
} = require('@solana/spl-token');
const schedule = require('node-schedule');
const bs58 = require('bs58');
const axios = require('axios');
require('dotenv').config();
const WebSocket = require('ws');

// Logging setup
let ws;
function initWebSocket() {
  ws = new WebSocket('wss://burn.incineratorlabs.xyz');

  ws.on('open', () => logInfo('[log stream] connected to dashboard'));
  ws.on('close', () => {
    logRetry('[log stream] disconnected, retrying...');
    setTimeout(initWebSocket, 3000);
  });
  ws.on('error', (err) => logError('[log stream error]', err.message));
}

const originalLog = console.log;
function fancyLog(type, ...args) {
  const emojiMap = { info: 'ℹ️', success: '🚀', error: '❌', retry: '⏳' };
  const emoji = emojiMap[type] || '';
  const msg = args.map(a => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
  const fullMsg = `${emoji} ${msg}`;
  originalLog(fullMsg);
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(fullMsg);
}

global.logInfo = (...args) => fancyLog('info', ...args);
global.logSuccess = (...args) => fancyLog('success', ...args);
global.logError = (...args) => fancyLog('error', ...args);
global.logRetry = (...args) => fancyLog('retry', ...args);

initWebSocket();

// Config
const SOLANA_RPC_URL = process.env.SOLANA_RPC_URL;
const TARGET_TOKEN_MINT = process.env.TARGET_TOKEN_MINT;
const INTERVAL = process.env.INTERVAL || '10m';
const BURN_RATIO = parseFloat(process.env.BURN_RATIO) || 0.01;
const PUMPSWAP_REWARD = process.env.PUMPSWAP_REWARD === 'true';
const MIN_BALANCE_SOL = BURN_RATIO * 1e9;

const connection = new Connection(SOLANA_RPC_URL, 'confirmed');
const privateKeyArray = Uint8Array.from(JSON.parse(process.env.PRIVATE_KEY));
const wallet = Keypair.fromSecretKey(privateKeyArray);
logInfo('Wallet Public Key:', wallet.publicKey.toBase58());

async function rpcWithRetry(fn, maxRetries = 5, baseDelay = 500) {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      if (error.message.includes('429')) {
        const delay = baseDelay * 2 ** attempt;
        logRetry(`429 rate limit. Retrying in ${delay}ms...`);
        await new Promise(res => setTimeout(res, delay));
      } else throw error;
    }
  }
  throw new Error('Max retries exceeded.');
}

async function fetchWithRetry(method, url, options = {}, maxRetries = 5, baseDelay = 500) {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      if (method === 'GET') return await axios.get(url, options);
      if (method === 'POST') return await axios.post(url, options.data, options);
    } catch (error) {
      if (error.response?.status === 429) {
        const delay = baseDelay * 2 ** attempt;
        logRetry(`429 Too Many Requests. Retrying in ${delay}ms...`);
        await new Promise(res => setTimeout(res, delay));
      } else throw error;
    }
  }
  throw new Error('Max retries exceeded.');
}

async function getTokenAccountBalance(tokenAccount) {
  try {
    const accountInfo = await getAccount(connection, tokenAccount);
    return accountInfo.amount;
  } catch (error) {
    logError(`Token account ${tokenAccount.toBase58()} not found.`);
    return BigInt(0);
  }
}

async function executeJupiterSwap(inputMint, outputMint, amountLamports) {
  try {
    const inAmount = amountLamports.toString();
    logInfo(`Swapping: ${inputMint.toBase58()} → ${outputMint.toBase58()} | Amount: ${Number(amountLamports) / 1e9} SOL`);

    const quoteResponse = await fetchWithRetry('GET', 'https://quote-api.jup.ag/v6/quote', {
      params: {
        inputMint: inputMint.toBase58(),
        outputMint: outputMint.toBase58(),
        amount: inAmount,
        slippageBps: 500,             // 5% slippage
        onlyDirectRoutes: false,      // Allow multi-hop (important!)
        exactIn: true,                // We're giving input amount
        onlyDirectRoutes: false, // 🆕 ADD THIS
      },
    });

    const quote = quoteResponse.data;

    if (!quote.routes || quote.routes.length === 0) {
      logError('❌ Jupiter swap error: No route found for this token.');
      return null;
    }

    const route = quote.routes[0]; // Select best route

    const swapInstructionsResponse = await fetch('https://quote-api.jup.ag/v6/swap-instructions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        quoteResponse: route,
        userPublicKey: wallet.publicKey.toBase58(),
      }),
    });

    const { swapTransaction } = await swapInstructionsResponse.json();

    const tx = VersionedTransaction.deserialize(Buffer.from(swapTransaction, 'base64'));
    tx.sign([wallet]);

    const txid = await connection.sendTransaction(tx, { skipPreflight: true });
    await connection.confirmTransaction(txid, 'confirmed');

    logSuccess(`Swap successful: https://solscan.io/tx/${txid}`);
    return txid;

  } catch (error) {
    logError('Jupiter swap error:', error.message);
    return null;
  }
}

async function claimPumpFunCreatorFee() {
  logInfo('Claiming Pump.fun Creator Fee...');

  const programId = new PublicKey("83DCwHSCjBXTRGDQAgW1SunV1DY8S6wk6suS2AqE15d");
  const instructionData = Buffer.from("1416567bc61cdb84", "hex");
  const keys = [
    { pubkey: wallet.publicKey, isSigner: true, isWritable: true },
    { pubkey: new PublicKey("9PRQYGFwcGhaMBx3KiPy62MSzaFyETDZ5U8Qr2HAavTX"), isSigner: false, isWritable: true },
    { pubkey: new PublicKey("11111111111111111111111111111111"), isSigner: false, isWritable: false },
    { pubkey: new PublicKey("Ce6TQqeHC9p8KetsN6JsjHK7UTZk7nasjjnr7XxXp9F1"), isSigner: false, isWritable: false },
    { pubkey: programId, isSigner: false, isWritable: false },
  ];

  const instruction = new TransactionInstruction({ keys, programId, data: instructionData });

  const blockhash = (await rpcWithRetry(() => connection.getLatestBlockhash())).blockhash;

  const tx = new Transaction({
    recentBlockhash: blockhash,
    feePayer: wallet.publicKey,
  }).add(instruction);

  try {
    const sig = await sendAndConfirmTransaction(connection, tx, [wallet]);
    logSuccess("Claim transaction sent:", sig);
  } catch (error) {
    logError("Claim transaction failed:", error.message);
  }
}
async function buyAndBurnToken() {
  try {
    logInfo('Starting Buy and Burn Process...');

    if (PUMPSWAP_REWARD) {
      await claimPumpFunCreatorFee();
    } else {
      logInfo('PUMPSWAP_REWARD is false. Skipping reward claim.');
    }

    const balance = await connection.getBalance(wallet.publicKey);
    logInfo(`Current SOL Balance: ${(balance / 1e9).toFixed(6)} SOL`);

    const amountToUse = balance - MIN_BALANCE_SOL;
    if (amountToUse <= 0) {
      logError('❌ Insufficient SOL balance to proceed.');
      return;
    }

    const solMint = new PublicKey('So11111111111111111111111111111111111111112');
    const targetMint = new PublicKey(TARGET_TOKEN_MINT);

    const swapTx = await executeJupiterSwap(solMint, targetMint, BigInt(amountToUse));
    if (!swapTx) return;

    const associatedTokenAccount = await getAssociatedTokenAddress(targetMint, wallet.publicKey);
    const tokenBalance = await getTokenAccountBalance(associatedTokenAccount);
    if (tokenBalance === BigInt(0)) {
      logError('❌ Token account has zero balance. Skipping burn.');
      return;
    }

    const burnInstruction = createBurnInstruction(
      associatedTokenAccount,
      targetMint,
      wallet.publicKey,
      tokenBalance
    );

    const blockhash = (await rpcWithRetry(() => connection.getLatestBlockhash())).blockhash;
    const transaction = new Transaction({ recentBlockhash: blockhash, feePayer: wallet.publicKey }).add(burnInstruction);

    try {
      const burnTx = await connection.sendTransaction(transaction, [wallet]);
      await connection.confirmTransaction(burnTx, 'confirmed');
      logSuccess(`🔥 Burn transaction sent and confirmed: https://solscan.io/tx/${burnTx}`);
    } catch (error) {
      logError('❌ Burn transaction error:', error.message);
    }

  } catch (error) {
    logError('❌ Error during Buy and Burn:', error.message);
  }
}

const intervalMinutes = parseInt(INTERVAL.replace('m', '')) || 30;
schedule.scheduleJob(`*/${intervalMinutes} * * * *`, buyAndBurnToken);
logSuccess('Bot is running...');

