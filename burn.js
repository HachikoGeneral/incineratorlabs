// Cycle - Automated Jupiter Swap + Burn Bot with Fancy Logs

const {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
} = require('@solana/web3.js');
const {
  getAssociatedTokenAddress,
  createBurnInstruction,
  getAccount,
} = require('@solana/spl-token');
const { Jupiter } = require('@jup-ag/core');
const schedule = require('node-schedule');
const axios = require('axios');
const WebSocket = require('ws');
require('dotenv').config();

// === Logging ===
let ws;
function initWebSocket() {
  ws = new WebSocket('wss://burn.incineratorlabs.xyz');

  ws.on('open', () => logInfo('[log stream] connected'));
  ws.on('close', () => setTimeout(initWebSocket, 3000));
  ws.on('error', (err) => logError('[log stream error]', err.message));
}

function fancyLog(type, ...args) {
  const emoji = { info: 'ℹ️', success: '🚀', error: '❌', retry: '⏳' }[type] || '';
  const msg = args.map(a => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
  const fullMsg = `${emoji} ${msg}`;
  console.log(fullMsg);
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(fullMsg);
}

const logInfo = (...a) => fancyLog('info', ...a);
const logSuccess = (...a) => fancyLog('success', ...a);
const logError = (...a) => fancyLog('error', ...a);
const logRetry = (...a) => fancyLog('retry', ...a);

initWebSocket();

// === Config ===
const SOLANA_RPC_URL = process.env.SOLANA_RPC_URL;
const PRIVATE_KEY = JSON.parse(process.env.PRIVATE_KEY);
const TARGET_TOKEN_MINT = new PublicKey(process.env.TARGET_TOKEN_MINT);
const INTERVAL = process.env.INTERVAL || '10m';
const BURN_RATIO = parseFloat(process.env.BURN_RATIO) || 0.01;
const PUMPSWAP_REWARD = process.env.PUMPSWAP_REWARD === 'true';

const connection = new Connection(SOLANA_RPC_URL, 'confirmed');
const wallet = Keypair.fromSecretKey(Uint8Array.from(PRIVATE_KEY));
const MIN_BALANCE_SOL = BURN_RATIO * 1e9;

logInfo('Wallet:', wallet.publicKey.toBase58());

async function rpcWithRetry(fn, max = 5, delay = 500) {
  for (let i = 0; i < max; i++) {
    try {
      return await fn();
    } catch (err) {
      if (err.message.includes('429')) {
        logRetry(`429 rate limit. Retrying in ${delay}ms...`);
        await new Promise(res => setTimeout(res, delay));
        delay *= 2;
      } else throw err;
    }
  }
  throw new Error('Max retries reached');
}

async function getTokenAccountBalance(tokenAccount) {
  try {
    const acc = await getAccount(connection, tokenAccount);
    return acc.amount;
  } catch {
    logError(`Token account ${tokenAccount.toBase58()} not found.`);
    return BigInt(0);
  }
}

async function claimPumpFunCreatorFee() {
  logInfo('Claiming Pump.fun Creator Fee...');
  const programId = new PublicKey("83DCwHSCjBXTRGDQAgW1SunV1DY8S6wk6suS2AqE15d");
  const data = Buffer.from("1416567bc61cdb84", "hex");
  const keys = [
    { pubkey: wallet.publicKey, isSigner: true, isWritable: true },
    { pubkey: new PublicKey("9PRQYGFwcGhaMBx3KiPy62MSzaFyETDZ5U8Qr2HAavTX"), isWritable: true, isSigner: false },
    { pubkey: new PublicKey("11111111111111111111111111111111"), isWritable: false, isSigner: false },
    { pubkey: new PublicKey("Ce6TQqeHC9p8KetsN6JsjHK7UTZk7nasjjnr7XxXp9F1"), isWritable: false, isSigner: false },
    { pubkey: programId, isWritable: false, isSigner: false },
  ];

  const ix = new TransactionInstruction({ keys, programId, data });
  const bh = (await rpcWithRetry(() => connection.getLatestBlockhash())).blockhash;
  const tx = new Transaction({ recentBlockhash: bh, feePayer: wallet.publicKey }).add(ix);

  try {
    const sig = await sendAndConfirmTransaction(connection, tx, [wallet]);
    logSuccess("Claim tx sent:", sig);
  } catch (e) {
    logError("Claim failed:", e.message);
  }
}

async function executeJupiterSwap(inputMint, outputMint, amountLamports) {
  try {
    const jupiter = await Jupiter.load({
      connection,
      cluster: 'mainnet-beta',
      user: wallet.publicKey,
    });

    const routes = await jupiter.computeRoutes({
      inputMint,
      outputMint,
      amount: Number(amountLamports),
      slippageBps: 100,
      forceFetch: true,
    });

    if (!routes || routes.routesInfos.length === 0) {
      logError('❌ Jupiter swap error: No route found for this token.');
      return null;
    }

    const bestRoute = routes.routesInfos[0];
    const { execute } = await jupiter.exchange({ routeInfo: bestRoute });
    const swapTxId = await execute();
    logSuccess(`✅ Swap successful: https://solscan.io/tx/${swapTxId}`);
    return swapTxId;

  } catch (error) {
    logError('Swap failed:', error.message);
    return null;
  }
}

async function buyAndBurnToken() {
  try {
    logInfo('Starting Buy and Burn...');

    if (PUMPSWAP_REWARD) {
      await claimPumpFunCreatorFee();
    } else {
      logInfo('PUMPSWAP_REWARD is false, skipping claim.');
    }

    const balance = await connection.getBalance(wallet.publicKey);
    logInfo(`Current SOL Balance: ${(balance / 1e9).toFixed(6)} SOL`);
    const amountToUse = balance - MIN_BALANCE_SOL;
    if (amountToUse <= 0) return logError('Not enough SOL to swap.');

    const solMint = new PublicKey('So11111111111111111111111111111111111111112');
    const swapTx = await executeJupiterSwap(solMint, TARGET_TOKEN_MINT, BigInt(amountToUse));
    if (!swapTx) return;

    const tokenAccount = await getAssociatedTokenAddress(TARGET_TOKEN_MINT, wallet.publicKey);
    const tokenBalance = await getTokenAccountBalance(tokenAccount);
    if (tokenBalance === BigInt(0)) return logError('No tokens received to burn.');

    const burnIx = createBurnInstruction(tokenAccount, TARGET_TOKEN_MINT, wallet.publicKey, tokenBalance);
    const bh = (await rpcWithRetry(() => connection.getLatestBlockhash())).blockhash;
    const burnTx = new Transaction({ recentBlockhash: bh, feePayer: wallet.publicKey }).add(burnIx);

    const sig = await connection.sendTransaction(burnTx, [wallet]);
    await connection.confirmTransaction(sig, 'confirmed');
    logSuccess(`🔥 Burned tokens: https://solscan.io/tx/${sig}`);

  } catch (e) {
    logError('Buy and Burn Error:', e.message);
  }
}

const minutes = parseInt(INTERVAL.replace('m', '')) || 30;
schedule.scheduleJob(`*/${minutes} * * * *`, buyAndBurnToken);
logSuccess('🔥 Bot is live and scheduled.');

