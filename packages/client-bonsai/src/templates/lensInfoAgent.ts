import {
    elizaLogger,
    composeContext,
    type IAgentRuntime,
    ModelProviderName,
    ModelClass,
    getModelSettings,
    generateText,
} from "@elizaos/core";
import type { Post, TextOnlyMetadata, ImageMetadata as LensImageMetadata, URI as LensURI } from "@lens-protocol/client";
import { privateKeyToAccount } from "viem/accounts";
import z from "zod";
import {
    ImageRequirement,
    TemplateCategory,
    TemplateName,
    type SmartMedia,
    type Template,
    type TemplateHandlerResponse,
    type TemplateUsage,
} from "../utils/types";
import { formatMetadata } from "../services/lens/createPost";
import { getLatestComments } from "../utils/utils";
import { fetchAllCommentsFor } from "../services/lens/posts";
import { LENS_CHAIN_ID, storageClient } from "../services/lens/client";
import { BONSAI_PROTOCOL_FEE_RECIPIENT } from "../utils/constants";
import { LanguageModelUsage } from "ai";
import axios from "axios";
import { v4 as uuidv4 } from 'uuid';
import { MediaImageMimeType, type ImageMetadata as StorageImageMetadata, type URI as StorageURI } from "@lens-protocol/metadata";
import { cacheImageStorj, cacheJsonStorj, uriToBuffer } from "../utils/ipfs";
import { walletOnly } from "@lens-chain/storage-client";

export const replyTemplate = `
# Instructions
You are an insightful agent that is researching data about Lens chain and Lens protocol, and replying to comments on your posts based on the provided agent behavior.
# Agent Behavior
{{agentBehavior}}

Your job is to create a single, concise question to find Lens Chain and Lens protocol data.
This question should be answerable in a short social media post.
For example: "What are the top 5 transactions on Lens Protocol in the last 24 hours?" or "Who are the most active new profiles on Lens in the past week?".
The question should be direct and not include any explanations, objectives, data sources, metrics, analysis, output descriptions, or considerations.
Generate only the question.

# Comments
{{comments}}

Generate a single, concise question to retrieve data for a social media post, based on your creator's desired behavior.
If comments are provided, ensure the question also considers these comments while still adhering to the primary behavior and the need for a concise question.
`;

type TemplateData = {
    modelBehavior: string;
};


/**
 * Handles the generation and updating of a "Evolving Art" type post.
 * This function refreshes an existing post by evaluating new comments and votes to decide the evolution of the image.
 *
 * @param {IAgentRuntime} runtime - The eliza runtime environment providing utilities for generating content and images.
 * @param {boolean} refresh - Flag indicating whether to generate a new page or update an existing one.
 * @param {SmartMedia} [media] - The current, persisted media object associated with the adventure, used for updates.
 * @param {TemplateData} [_templateData] - Initial data for generating a new adventure preview, used when not refreshing.
 * @returns {Promise<TemplateHandlerResponse | null>} A promise that resolves to the response object containing the new image preview, uri (optional), and updated template data, or null if the operation cannot be completed.
 */
const lensInfoAgent = {
    handler: async (
        runtime: IAgentRuntime,
        media?: SmartMedia,
        _templateData?: TemplateData,
        options?: { forceUpdate: boolean },
    ): Promise<TemplateHandlerResponse | undefined> => {
        const refresh = !!media?.templateData;
        elizaLogger.info(`Running template (refresh: ${refresh}):`, TemplateName.LENS_INFO_AGENT);

        const templateData = refresh ? media?.templateData as TemplateData : _templateData;
        if (!templateData) {
            elizaLogger.error("Missing template data");
            return;
        }

        elizaLogger.info(`Template data: ${JSON.stringify(templateData)}`);

        let totalUsage: TemplateUsage = {
            promptTokens: 0,
            completionTokens: 0,
            totalTokens: 0,
            imagesCreated: 0,
        };

        try {
            let comments: Post[] = [];

            if (refresh) {
                elizaLogger.info(`Fetching all comments for post ${media?.postId}`);
                const allComments = await fetchAllCommentsFor(
                    media?.postId as string
                );

                elizaLogger.info(`Fetched ${allComments.length} comments for post ${media?.postId}`);
                comments = getLatestComments(media as SmartMedia, allComments);
            }

            const context = composeContext({
                // @ts-expect-error we don't need the full State object here to produce the context
                state: {
                    agentBehavior: templateData?.modelBehavior,
                    // info: templateData?.info, //
                    comments: comments
                        .map((c) => (c.metadata as TextOnlyMetadata).content)
                        .join("\\n"),
                },
                template: replyTemplate,
            });

            const generatedQuery = await generateText({
                runtime,
                context,
                modelClass: ModelClass.MEDIUM,
                modelProvider: ModelProviderName.GOOGLE,
                returnUsage: true,
                tools: {},
            }) as { response: string, usage: any };

            totalUsage.promptTokens += generatedQuery.usage.promptTokens || 0;
            totalUsage.completionTokens += generatedQuery.usage.completionTokens || 0;
            totalUsage.totalTokens += generatedQuery.usage.totalTokens || 0;

            elizaLogger.info(`generatedQuery: ${JSON.stringify(generatedQuery.response)}`);

            const agentResponse = await axios.get(process.env.AGENT_URL as string, {
                params: {
                    message: generatedQuery.response
                },
            });

            const agentResponseData = agentResponse.data
            const agentResponseMessage = agentResponseData.message
            const agentResponseChart = agentResponseData.chart

            elizaLogger.info(`agentResponse data: ${JSON.stringify(agentResponseMessage)}`);
            elizaLogger.info(`agentResponse chart: ${JSON.stringify(agentResponseChart)}`);

            let currentPostContent = "";
            let currentMetadata: StorageImageMetadata | undefined;
            let originalPostUri: LensURI | undefined;
            let attributesFromExistingPost: any[] = [];
            const queryAttribute = { key: "query", value: generatedQuery.response, type: 'String' };

            if (refresh && media?.uri) {
                originalPostUri = media.uri as unknown as LensURI;
                const url = await storageClient.resolve(media.uri as unknown as StorageURI);
                currentMetadata = await fetch(url).then(res => res.json()) as StorageImageMetadata;
                currentPostContent = currentMetadata?.lens?.content || "";
                attributesFromExistingPost = currentMetadata?.lens?.attributes || [];
                elizaLogger.info(`Fetched existing metadata from ${media.uri}`);
            } else {
                elizaLogger.info("This is a new post or media.uri is not available.");
            }

            let chartImageUrl: string | undefined;
            if (agentResponseChart) {
                const chartUploadResponse = await axios.post(
                    process.env.IMAGE_GENERATION_URL as string,
                    {
                        data: agentResponseChart,
                        options: {
                            type: agentResponseChart.type,
                            title: agentResponseChart.title,
                            width: 600,
                            height: 450,
                        },
                    },
                    { responseType: 'arraybuffer' }
                );

                const imageBuffer = Buffer.from(chartUploadResponse.data);
                const imageId = uuidv4();
                const storjResult = await cacheImageStorj({ id: `${imageId}.png`, buffer: imageBuffer, ContentType: MediaImageMimeType.PNG } as any);
                if (storjResult.success && storjResult.url) {
                    chartImageUrl = storjResult.url;
                } else {
                    elizaLogger.error('Failed to cache chart image:', storjResult.error);
                }
                elizaLogger.info(`Chart image URL: ${chartImageUrl}`);
            }

            const newPostContent = agentResponseMessage;

            let metadataToUpload: StorageImageMetadata;
            let persistVersionUri: string | undefined;

            if (refresh && currentMetadata && originalPostUri) {
                const storjResult = await cacheJsonStorj({ id: `${currentMetadata.lens.id}-version-${media.versionCount || 0}.json`, data: currentMetadata });
                if (storjResult.success && storjResult.url) {
                    persistVersionUri = storjResult.url;
                    elizaLogger.info(`Cached previous version to ${persistVersionUri}`);
                } else {
                    elizaLogger.error('Failed to cache previous version metadata:', storjResult.error);
                }

                let finalAttributes = [...attributesFromExistingPost];
                if (finalAttributes.length === 0) {
                    finalAttributes.push(queryAttribute);
                }

                elizaLogger.info(`Final attributes before formatMetadata: ${JSON.stringify(finalAttributes)}`);
                metadataToUpload = formatMetadata({
                    text: newPostContent,
                    image: chartImageUrl ? { url: chartImageUrl, type: MediaImageMimeType.PNG } : undefined,
                    attributes: finalAttributes,
                    media: {
                        category: TemplateCategory.INSIGHTS,
                        name: TemplateName.LENS_INFO_AGENT,
                    },
                }) as StorageImageMetadata;

                const signer = privateKeyToAccount(process.env.LENS_STORAGE_NODE_PRIVATE_KEY as `0x${string}`);
                const acl = walletOnly(signer.address, LENS_CHAIN_ID);
                await storageClient.updateJson(originalPostUri as unknown as StorageURI, metadataToUpload, signer, { acl });
                elizaLogger.info(`Updated metadata at ${originalPostUri}`);

            } else {
                let finalAttributes: any[] = [];
                finalAttributes = [...attributesFromExistingPost, queryAttribute];

                elizaLogger.info(`Final attributes before formatMetadata: ${JSON.stringify(finalAttributes)}`);
                metadataToUpload = formatMetadata({
                    text: newPostContent,
                    image: chartImageUrl ? { url: chartImageUrl, type: MediaImageMimeType.PNG } : undefined,
                    attributes: finalAttributes,
                    media: {
                        category: TemplateCategory.INSIGHTS,
                        name: TemplateName.LENS_INFO_AGENT,
                    },
                }) as StorageImageMetadata;
                elizaLogger.info("Formatted metadata for new post.");
                elizaLogger.info(`Full metadata for new post: ${JSON.stringify(metadataToUpload)}`);
            }

            // Log for existing post (refresh)
            if (refresh && metadataToUpload) {
                elizaLogger.info(`Full metadata for updated post: ${JSON.stringify(metadataToUpload)}`);
            }

            return {
                // @ts-ignore
                metadata: metadataToUpload as unknown as LensImageMetadata,
                preview: !refresh ? {
                    text: newPostContent,
                    image: chartImageUrl
                } : undefined,
                uri: !refresh ? undefined : originalPostUri as LensURI,
                refreshMetadata: refresh,
                updatedTemplateData: {
                    ...templateData,
                    lastResponseMessage: agentResponseMessage,
                    lastChartUrl: chartImageUrl,
                },
                persistVersionUri,
                totalUsage,
                refreshCache: true,
            };
        } catch (error) {
            console.log(error);
            elizaLogger.error("handler failed", error);
        }
    },
    clientMetadata: {
        protocolFeeRecipient: BONSAI_PROTOCOL_FEE_RECIPIENT,
        category: TemplateCategory.INSIGHTS,
        name: TemplateName.LENS_INFO_AGENT,
        displayName: "Lens Info Agent",
        description:
            "An AI assistant specialized on reseaching data about Lens chain and Lens protocol.",
        image: "https://link.storjshare.io/raw/jwr2m6ilrn5q2ayhuk2osvt7rjgq/bonsai/infoAgent.png",
        options: {
            allowPreview: false,
            allowPreviousToken: true,
            imageRequirement: ImageRequirement.NONE,
            requireContent: false,
        },
        defaultModel: getModelSettings(ModelProviderName.GOOGLE, ModelClass.MEDIUM)?.name,
        templateData: {
            form: z.object({
                modelBehavior: z.string().describe("Set the initial behavior of the agent."),
            })
        },
    },
} as Template;

export default lensInfoAgent;
