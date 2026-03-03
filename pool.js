const net = require('net');
const crypto = require('crypto');
const rpc = require('node-json-rpc');
const async = require('async');
const bignum = require('bignum');
const express = require('express');
const mysql = require('mysql');

// Load native addon
const yespower = require('./build/Release/yespowerR16');

// Configuration
const config = require('./config.json');

// RPC client for coin daemon
const rpcClient = new rpc.Client({
    host: config.daemon.host,
    port: config.daemon.port,
    path: '/',
    strictSSL: false,
    headers: {
        'Authorization': 'Basic ' + Buffer.from(config.daemon.user + ':' + config.daemon.pass).toString('base64')
    }
});

// Database connection
const db = mysql.createConnection(config.database);
db.connect();

// Stratum server
const server = net.createServer((socket) => {
    let miner = {
        socket: socket,
        address: null,
        worker: null,
        difficulty: config.difficulty,
        extraNonce1: generateExtraNonce(),
        subscriptions: []
    };

    socket.on('data', (data) => {
        // Handle Stratum messages (mining.subscribe, mining.authorize, mining.submit)
        try {
            const message = JSON.parse(data.toString().trim());
            handleMessage(miner, message);
        } catch (e) {
            console.error('Parse error', e);
        }
    });

    socket.on('end', () => {
        console.log('Miner disconnected', miner.address);
    });
});

server.listen(config.port, config.host, () => {
    console.log(`Stratum server listening on ${config.host}:${config.port}`);
});

// HTTP API for stats
const app = express();
app.get('/api/stats', (req, res) => {
    // Return pool stats (hashrate, miners, blocks found)
    res.json({
        miners: Object.keys(miners).length,
        hashrate: poolHashrate,
        blocks: blocksFound
    });
});
app.listen(8080, () => console.log('API on port 8080'));

// Mining job generator
let currentJob = null;
let jobId = 0;

function getBlockTemplate() {
    rpcClient.call({ method: 'getblocktemplate', params: [{ capabilities: ['coinbasetxn'] }] }, (err, result) => {
        if (err) {
            console.error('RPC error', err);
            setTimeout(getBlockTemplate, 1000);
            return;
        }
        // Parse template and create job
        const template = result.result;
        const job = {
            id: ++jobId,
            prevhash: template.previousblockhash,
            coinbasetxn: template.coinbasetxn,
            coinbasevalue: template.coinbasevalue,
            target: template.target,
            height: template.height,
            bits: template.bits,
            timestamp: template.curtime,
            version: template.version,
            default_witness_commitment: template.default_witness_commitment || null,
            nonceRange: '00000000ffffffff',
            // Build merkle root (simplified)
            merkleRoot: template.coinbasetxn.hash // In real pool you'd build merkle tree
        };
        currentJob = job;
        broadcastJob(job);
        setTimeout(getBlockTemplate, 30000); // refresh every 30 seconds
    });
}
getBlockTemplate();

function broadcastJob(job) {
    const jobMessage = {
        id: null,
        method: 'mining.notify',
        params: [
            job.id.toString(),
            job.prevhash,
            job.coinbasetxn.hash, // actually you'd send coinbase1 + coinbase2
            job.merkleRoot,
            job.version.toString(16),
            job.bits,
            job.timestamp.toString(16),
            false // clean jobs
        ]
    };
    for (let addr in miners) {
        miners[addr].socket.write(JSON.stringify(jobMessage) + '\n');
    }
}

// Share validation
function validateShare(miner, jobId, nonce, hash) {
    // Check if job exists and is current
    if (jobId !== currentJob.id) return false;

    // Compute header hash using yespower
    const header = Buffer.alloc(80);
    // Fill header with data from job + nonce
    // ... (implementation depends on coin's block header format)

    const resultHash = yespower.hash(header, nonce);

    // Compare with target
    const target = bignum(currentJob.target, 16);
    const hashNum = bignum.fromBuffer(resultHash, { endian: 'little' });
    if (hashNum.gt(target)) return false; // not a valid share

    // If it meets network difficulty, submit block
    const networkTarget = bignum(config.networkDifficulty, 16); // get from daemon
    if (hashNum.lte(networkTarget)) {
        // Submit block
        const blockData = buildBlock(currentJob, nonce, resultHash);
        rpcClient.call({ method: 'submitblock', params: [blockData] }, (err, res) => {
            if (err) console.error('Block submission error', err);
            else console.log('Block found!', res);
        });
    }

    // Accept share – record in DB
    db.query('INSERT INTO shares (address, job_id, nonce, hash, difficulty) VALUES (?,?,?,?,?)',
        [miner.address, jobId, nonce, resultHash.toString('hex'), miner.difficulty]);

    return true;
}

// Message handlers
function handleMessage(miner, msg) {
    switch (msg.method) {
        case 'mining.subscribe':
            miner.subscriptions.push(msg.params[0]);
            sendJson(miner, {
                id: msg.id,
                result: [
                    [['mining.set_difficulty', '1'], ['mining.notify', '1']],
                    miner.extraNonce1,
                    4
                ],
                error: null
            });
            break;
        case 'mining.authorize':
            const parts = msg.params[0].split('.');
            miner.address = parts[0];
            miner.worker = parts[1] || 'default';
            miners[miner.address] = miner;
            sendJson(miner, { id: msg.id, result: true, error: null });
            // Send difficulty
            sendJson(miner, { id: null, method: 'mining.set_difficulty', params: [miner.difficulty] });
            // Send initial job
            if (currentJob) {
                sendJob(miner, currentJob);
            }
            break;
        case 'mining.submit':
            const jobId = msg.params[1];
            const nonce = msg.params[2];
            const hash = msg.params[3]; // sometimes included
            if (validateShare(miner, jobId, nonce, hash)) {
                sendJson(miner, { id: msg.id, result: true, error: null });
            } else {
                sendJson(miner, { id: msg.id, result: false, error: 'Invalid share' });
            }
            break;
        default:
            console.log('Unknown method', msg.method);
    }
}

function sendJson(socket, obj) {
    socket.write(JSON.stringify(obj) + '\n');
}

function generateExtraNonce() {
    return crypto.randomBytes(4).toString('hex');
}

// Stats tracking
let miners = {};
let poolHashrate = 0;
let blocksFound = [];

// Update hashrate every minute
setInterval(() => {
    // Query shares from last 5 minutes, calculate hashrate
    // ... implementation
}, 60000);
