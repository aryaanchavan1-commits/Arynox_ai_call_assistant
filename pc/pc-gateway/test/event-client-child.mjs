import { GatewayRpcClient } from '../src/gateway-rpc.js';

const client = new GatewayRpcClient({ socketPath: process.env.AGENTCALL_RPC_SOCKET });
await client.startEvents();
process.stdout.write('EVENTS_READY\n');
client.stopEvents();
