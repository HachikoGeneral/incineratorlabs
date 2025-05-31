// burn-daily-12utc.js - Burn 50% of token balance every day at 12:00 UTC & tweet result

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
const { TwitterApi } = require('twitter-api-v2');
require('dotenv').config();

// --- Setup ---
const connection = new Connection(process.env.SOLANA_RPC_URL, 'confirmed');
const privateKeyArray = Uint8Array.from(JSON.parse(process.env.PRIVATE_KEY));
const wallet = Keypair.fromSecretKey(privateKeyArray);
const TARGET_TOKEN_MINT = new PublicKey(process.env.TARGET_TOKEN_MINT);

// --- Twitter ---
const twitterClient = new TwitterApi({
  appKey: process.env.TWITTER_API_KEY,
  appSecret: process.env.TWITTER_API_SECRET,
  accessToken: process.env.TWITTER_ACCESS_TOKEN,
  accessSecret: process.env.TWITTER_ACCESS_SECRET,
});

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

async function retry(fn, retries = 3, delayMs = 5000) {
  for (let i = 0; i < retries; i++) {
    try {
      return await fn();
    } catch (err) {
      logError(`Attempt ${i + 1} failed:`, err.message);
      if (i < retries - 1) {
        await new Promise(res => setTimeout(res, delayMs));
      } else {
        throw err;
      }
    }
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

    const sig = await retry(async () => {
      const burnIx = createBurnInstruction(ata, TARGET_TOKEN_MINT, wallet.publicKey, burnAmount);
      const { blockhash } = await connection.getLatestBlockhash();

      const tx = new Transaction({
        feePayer: wallet.publicKey,
        recentBlockhash: blockhash,
      }).add(burnIx);

      return await sendAndConfirmTransaction(connection, tx, [wallet], {
        skipPreflight: false,
        preflightCommitment: 'confirmed',
      });
    });

    const txUrl = `https://solscan.io/tx/${sig}`;
    logSuccess(`🔥 Burned | Tx: ${txUrl}`);

    await retry(async () => {
      const tweetText = `🔥 Burn successful! 50% of wallet token balance destroyed.\nTx: ${txUrl}\nTime: ${new Date().toISOString()}\n#Solana #BurnBot`;
      await twitterClient.v2.tweet(tweetText);
      logSuccess('📤 Tweet posted.');
    });

  } catch (err) {
    logError('Burn or Tweet failed after retries:', err.message);
  }
}

schedule.scheduleJob('0 12 * * *', burnHalfTokenBalance); // Runs every day at 12:00 UTC

