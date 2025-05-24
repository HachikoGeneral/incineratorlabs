// burn-daily-12utc.js - Burn 50% of token balance every day at 12:00 UTC

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

// --- Config ---
const connection = new Connection(process.env.SOLANA_RPC_URL, 'confirmed');
const privateKeyArray = Uint8Array.from(JSON.parse(process.env.PRIVATE_KEY));
const wallet = Keypair.fromSecretKey(privateKeyArray);
const TARGET_TOKEN_MINT = new PublicKey(process.env.TARGET_TOKEN_MINT);

// --- Logging ---
function logInfo(...args) {
  console.log('ℹ️', ...args);
}
function logSuccess(...args) {
  console.log('🚀', ...args);
}
function logError(...args) {
  console.error('❌', ...args);
}

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
    logInfo('🔁 Starting 50% burn (12:00 UTC)...');
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

// --- Schedule daily at 12:00 UTC ---
schedule.scheduleJob('0 12 * * *', burnHalfTokenBalance);
logSuccess('🔥 Burn bot (50%) scheduled for 12:00 UTC daily...');

