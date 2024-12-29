import { Provider } from 'zksync-ethers';
import { Contract } from 'zksync-ethers';
import { WebSocketProvider } from 'ethers';
import { elizaLogger } from "@elizaos/core";

interface EventListenerConfig {
    rpcUrl: string;
    contractAddress: string;
    contractABI: any[];
    eventName: string;
}

export class ContractEventListener {
    private rpcUrl: string;
    private provider: Provider | WebSocketProvider;
    private contract: Contract;
    private eventName: string;

    constructor(config: EventListenerConfig) {
        this.rpcUrl = config.rpcUrl;

        // Use WebSocketProvider for WSS URLs, otherwise use zkSync Provider
        if (this.rpcUrl.startsWith('wss://')) {
            elizaLogger.log('Using WebSocket provider');
            this.provider = new WebSocketProvider(this.rpcUrl);
        } else {
            elizaLogger.log('Using HTTP provider');
            this.provider = new Provider(this.rpcUrl);
        }

        this.contract = new Contract(
            config.contractAddress,
            config.contractABI,
            this.provider
        );
        this.eventName = config.eventName;
    }

    public startListening(): void {
        elizaLogger.log(`Starting to listen for ${this.eventName} events...`);

        this.contract.on(this.eventName, (...args) => {
            const event = args[args.length - 1];
            elizaLogger.log(`New ${this.eventName} event detected:`);
            elizaLogger.log('Event data:', {
                blockNumber: event.blockNumber,
                transactionHash: event.transactionHash,
                args: args.slice(0, -1)
            });
        });

        // Handle provider errors
        this.provider.on('error', (error: Error) => {
            elizaLogger.error('Provider Error:', error);
            this.reconnect();
        });
    }

    public stopListening(): void {
        elizaLogger.log('Stopping event listener...');
        this.contract.removeAllListeners(this.eventName);
        this.provider.removeAllListeners();
    }


    private async reconnect(): Promise<void> {
        elizaLogger.log('Attempting to reconnect...');
        try {
            // Recreate the appropriate provider type
            if (this.rpcUrl.startsWith('wss://')) {
                this.provider = new WebSocketProvider(this.rpcUrl);
            } else {
                this.provider = new Provider(this.rpcUrl);
            }

            this.contract = new Contract(
                this.contract.target as string,
                this.contract.interface.fragments,
                this.provider
            );
            this.startListening();
            elizaLogger.log('Successfully reconnected');
        } catch (error) {
            elizaLogger.error('Reconnection failed:', error);
            setTimeout(() => this.reconnect(), 5000);
        }
    }
}