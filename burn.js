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
const INTERVAL = process.env.INTERVAL || '120m';
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

    const quoteUrl = `https://quote-api.jup.ag/v6/quote?inputMint=${inputMint.toBase58()}&outputMint=${outputMint.toBase58()}&amount=${inAmount}&slippageBps=50`;
    const quoteResponse = await fetchWithRetry('GET', quoteUrl);
    const quoteData = quoteResponse.data;
    if (!quoteData.routes || quoteData.routes.length === 0) {
      logError('No route found for this token pair.');
      return null;
    }

    const swapInstructionsResponse = await fetchWithRetry('POST', 'https://quote-api.jup.ag/v6/swap-instructions', {
      data: {
        quoteResponse: quoteData,
        userPublicKey: wallet.publicKey.toBase58(),
      },
    });
    const swapInstructions = swapInstructionsResponse.data;

    const blockhash = (await rpcWithRetry(() => connection.getLatestBlockhash())).blockhash;
    const transaction = new Transaction({ feePayer: wallet.publicKey, recentBlockhash: blockhash });

    for (const ix of swapInstructions.swapTransaction.message.instructions) {
      const keys = ix.accounts.map(a => ({
        pubkey: new PublicKey(a.pubkey),
        isSigner: a.isSigner,
        isWritable: a.isWritable,
      }));
      transaction.add(new TransactionInstruction({
        programId: new PublicKey(ix.programId),
        keys,
        data: Buffer.from(ix.data, 'base64'),
      }));
    }

    const signedTx = await wallet.signTransaction(transaction);
    const txid = await connection.sendRawTransaction(signedTx.serialize());
    await connection.confirmTransaction(txid, 'confirmed');
    logSuccess(`Swap transaction successful: https://solscan.io/tx/${txid}`);
    return txid;
  } catch (err) {
    logError('Jupiter swap error:', err.message);
    return null;
  }
}

async function buyAndBurnToken() {
  try {
    logInfo('Starting Buy and Burn Process...');

    if (PUMPSWAP_REWARD) {
      // Optional logic here to claim pump.fun rewards
      logInfo('Skipping pump.fun logic for simplicity');
    }

    const balance = await connection.getBalance(wallet.publicKey);
    logInfo(`Current SOL Balance: ${(balance / 1e9).toFixed(6)} SOL`);
    const amountToUse = balance - MIN_BALANCE_SOL;
    if (amountToUse <= 0) {
      logError('Insufficient SOL balance to proceed.');
      return;
    }

    const solMint = new PublicKey('So11111111111111111111111111111111111111112');
    const targetMint = new PublicKey(TARGET_TOKEN_MINT);
    const swapTx = await executeJupiterSwap(solMint, targetMint, BigInt(amountToUse));
    if (!swapTx) return;

    const associatedTokenAccount = await getAssociatedTokenAddress(targetMint, wallet.publicKey);
    const tokenBalance = await getTokenAccountBalance(associatedTokenAccount);
    if (tokenBalance === BigInt(0)) {
      logError('Token account has zero balance. Skipping burn.');
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
      logSuccess(`Burn transaction confirmed: https://solscan.io/tx/${burnTx}`);
    } catch (error) {
      logError('Burn transaction error:', error.message);
    }
  } catch (error) {
    logError('Error during Buy and Burn:', error.message);
  }
}

const intervalMinutes = parseInt(INTERVAL.replace('m', '')) || 30;
schedule.scheduleJob(`*/${intervalMinutes} * * * *`, buyAndBurnToken);
logSuccess('Bot is running...');

