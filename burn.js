// burn-50pct.js - Burn 50% of token balance every 10 minutes

const {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  sendAndConfirmTransaction,
} = require('@solana/web3.js');
const {
  getAssociatedTokenAddress,
  createBurnInstruction,
  getAccount,
} = require('@solana/spl-token');
const schedule = require('node-schedule');
require('dotenv').config();

const WebSocket = require('ws');

// --- Logging & WebSocket ---
let ws;
function initWebSocket() {
  ws = new WebSocket('wss://burn.incineratorlabs.xyz');
  ws.on('open', () => logInfo('[log stream] connected'));
  ws.on('close', () => setTimeout(initWebSocket, 3000));
  ws.on('error', err => logError('[log stream]', err.message));
}
function fancyLog(type, ...args) {
  const emojiMap = { info: 'ℹ️', success: '🚀', error: '❌', retry: '⏳' };
  const msg = `${emojiMap[type]} ${args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ')}`;
  console.log(msg);
  if (ws?.readyState === WebSocket.OPEN) ws.send(msg);
}
const logInfo = (...args) => fancyLog('info', ...args);
const logSuccess = (...args) => fancyLog('success', ...args);
const logError = (...args) => fancyLog('error', ...args);

initWebSocket();

// --- Config ---
const connection = new Connection(process.env.SOLANA_RPC_URL, 'confirmed');
const privateKeyArray = Uint8Array.from(JSON.parse(process.env.PRIVATE_KEY));
const wallet = Keypair.fromSecretKey(privateKeyArray);
const TARGET_TOKEN_MINT = new PublicKey(process.env.TARGET_TOKEN_MINT);
const INTERVAL = process.env.INTERVAL || 60m';

// --- Helpers ---
async function getTokenAccountBalance(tokenAccount) {
  try {
    const accountInfo = await getAccount(connection, tokenAccount);
    return accountInfo.amount;
  } catch {
    return BigInt(0);
  }
}

// --- Burn 50% ---
async function burnHalfTokenBalance() {
  try {
    logInfo('🔁 Starting 50% burn cycle...');
    const ata = await getAssociatedTokenAddress(TARGET_TOKEN_MINT, wallet.publicKey);
    const tokenBalance = await getTokenAccountBalance(ata);

    if (tokenBalance === BigInt(0)) {
      logError('No tokens to burn.');
      return;
    }

    const burnAmount = tokenBalance / BigInt(2);
    const burnIx = createBurnInstruction(ata, TARGET_TOKEN_MINT, wallet.publicKey, burnAmount);
    const blockhash = (await connection.getLatestBlockhash()).blockhash;

    const tx = new Transaction({ feePayer: wallet.publicKey, recentBlockhash: blockhash }).add(burnIx);
    const sig = await sendAndConfirmTransaction(connection, tx, [wallet]);
    logSuccess(`🔥 Burned 50% | Tx: https://solscan.io/tx/${sig}`);
  } catch (err) {
    logError('Burn error:', err.message);
  }
}

// --- Schedule burn every X minutes ---
const minutes = parseInt(INTERVAL.replace('m', ''));
schedule.scheduleJob(`*/${minutes} * * * *`, burnHalfTokenBalance);
logSuccess('🔥 Burn bot (50%) running every 60 minutes...');
;



