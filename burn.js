// burn.js - Combined Buy, Claim, Burn Bot using Jupiter REST APIs

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
const axios = require('axios');
require('dotenv').config();

const WebSocket = require('ws');

// Logging + WebSocket to dashboard
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
const logRetry = (...args) => fancyLog('retry', ...args);

initWebSocket();

// Config
const connection = new Connection(process.env.SOLANA_RPC_URL, 'confirmed');
const privateKeyArray = Uint8Array.from(JSON.parse(process.env.PRIVATE_KEY));
const wallet = Keypair.fromSecretKey(privateKeyArray);
const TARGET_TOKEN_MINT = new PublicKey(process.env.TARGET_TOKEN_MINT);
const INTERVAL = process.env.INTERVAL || '10m';
const BURN_RATIO = parseFloat(process.env.BURN_RATIO) || 0.01;
const MIN_BALANCE_SOL = BURN_RATIO * 1e9;

// Helper: fetch with retries
async function fetchWithRetry(config, maxRetries = 5, delay = 500) {
  for (let i = 0; i < maxRetries; i++) {
    try {
      return await axios(config);
    } catch (err) {
      if (err.response?.status === 429) {
        logRetry('429 rate limit, retrying...');
        await new Promise(res => setTimeout(res, delay * 2 ** i));
      } else throw err;
    }
  }
}

// Get token account balance safely
async function getTokenAccountBalance(tokenAccount) {
  try {
    const accountInfo = await getAccount(connection, tokenAccount);
    return accountInfo.amount;
  } catch {
    return BigInt(0);
  }
}

// Executes a swap on Jupiter from inputMint to outputMint for amountLamports of input token (SOL=lamports)
async function executeJupiterSwap(inputMint, outputMint, amountLamports) {
  const inAmount = amountLamports.toString();

  logInfo(`Getting route from Jupiter for swapping ${amountLamports} lamports...`);
  const quoteRes = await fetchWithRetry({
    method: 'GET',
    url: 'https://quote-api.jup.ag/v6/quote',
    params: {
      inputMint: inputMint.toBase58(),
      outputMint: outputMint.toBase58(),
      amount: inAmount,
      slippageBps: 100,
    },
  });

  const quote = quoteRes.data;
  if (!quote.routes || quote.routes.length === 0) {
    logError('No route found for this token.');
    return null;
  }

  const route = quote.routes[0];
  logInfo('Route found, requesting swap transaction...');

  const swapRes = await fetchWithRetry({
    method: 'POST',
    url: 'https://quote-api.jup.ag/v6/swap',
    data: {
      route,
      userPublicKey: wallet.publicKey.toBase58(),
      wrapUnwrapSOL: true,
      feeAccount: null,
    },
  });

  if (!swapRes.data || !swapRes.data.swapTransaction) {
    logError('Swap transaction data missing from Jupiter response.');
    return null;
  }

  const swapTx = swapRes.data.swapTransaction;
  const txBuffer = Buffer.from(swapTx, 'base64');
  const transaction = Transaction.from(txBuffer);
  transaction.feePayer = wallet.publicKey;

  // Important: fetch recent blockhash for transaction before signing
  const { blockhash } = await connection.getLatestBlockhash();
  transaction.recentBlockhash = blockhash;

  // Sign the transaction with your wallet keypair
  transaction.sign(wallet);

  try {
    const sig = await connection.sendRawTransaction(transaction.serialize());
    logSuccess(`Swap transaction sent: https://solscan.io/tx/${sig}`);
    await connection.confirmTransaction(sig, 'confirmed');
    logSuccess(`Swap transaction confirmed: ${sig}`);
    return sig;
  } catch (err) {
    logError('Error sending swap transaction:', err.message);
    return null;
  }
}

async function buyAndBurnToken() {
  try {
    logInfo('Starting buy and burn cycle...');
    const balance = await connection.getBalance(wallet.publicKey);
    logInfo(`Current SOL balance: ${(balance / 1e9).toFixed(6)} SOL`);

    // Calculate amount to use for swap after keeping minimum SOL for fees
    const amountToUse = balance - MIN_BALANCE_SOL;
    if (amountToUse <= 0) {
      logError('Insufficient SOL balance to perform swap.');
      return;
    }

    const SOL_MINT = new PublicKey('So11111111111111111111111111111111111111112');

    // Swap SOL for target token
    const swapSignature = await executeJupiterSwap(SOL_MINT, TARGET_TOKEN_MINT, BigInt(amountToUse));
    if (!swapSignature) return;

    // Check token balance after swap
    const ata = await getAssociatedTokenAddress(TARGET_TOKEN_MINT, wallet.publicKey);
    const tokenBalance = await getTokenAccountBalance(ata);
    if (tokenBalance === BigInt(0)) {
      logError('No tokens received from swap to burn.');
      return;
    }

    // Create burn instruction
    const burnIx = createBurnInstruction(ata, TARGET_TOKEN_MINT, wallet.publicKey, tokenBalance);

    // Create and send burn transaction
    const { blockhash } = await connection.getLatestBlockhash();
    const burnTx = new Transaction({ feePayer: wallet.publicKey, recentBlockhash: blockhash }).add(burnIx);

    const burnSig = await sendAndConfirmTransaction(connection, burnTx, [wallet]);
    logSuccess(`🔥 Burn transaction confirmed: https://solscan.io/tx/${burnSig}`);
  } catch (err) {
    logError('Error in buy and burn process:', err.message);
  }
}

// Schedule the job based on INTERVAL, default every 10 minutes
const minutes = parseInt(INTERVAL.replace('m', ''));
schedule.scheduleJob(`*/${minutes} * * * *`, buyAndBurnToken);

logSuccess('🔥 Burn bot is running...');



