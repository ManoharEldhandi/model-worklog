import { LocalSupervisorClient } from 'model-worklog-sdk';

/**
 * A minimal product-side integration. Replace `runDummyModel` with the call to
 * your model/provider, retaining the observable lifecycle and tool callbacks.
 */
async function runDummyModel(prompt) {
	return {
		answer: `Demo answer: ${prompt} is ready for review.`,
		providerResponse: {
			object: 'response',
			id: 'resp_dummy_model_001',
			model: 'gpt-5.6-terra',
			usage: {
				input_tokens: 42,
				output_tokens: 18,
				output_tokens_details: { reasoning_tokens: 6 },
				total_tokens: 60,
			},
		},
	};
}

async function main() {
	const client = await LocalSupervisorClient.fromLocalEnvironment();
	const session = await client.startSession({
		workspacePath: process.cwd(),
		actor: 'demo-product-model',
		runMode: 'observe',
	});

	try {
		await session.emitEvent('adapter.lifecycle', {
			adapter: 'demo-product',
			phase: 'request-started',
			model: 'gpt-5.6-terra',
		});

		const prompt = 'Summarize the current product health.';
		await session.message(`Visible request: ${prompt}`);

		const correlationId = 'tool_product_status_001';
		await session.toolCalled({
			tool: 'get_product_status',
			arguments: { scope: 'demo' },
			correlationId,
		});
		await session.toolCompleted({
			tool: 'get_product_status',
			success: true,
			result: { status: 'healthy', checkedServices: 3 },
			correlationId,
		});

		const result = await runDummyModel(prompt);
		await session.summary(result.answer);
		await session.reportProviderUsage('openai', result.providerResponse);
		await session.testCompleted({
			name: 'dummy-model-response-contract',
			success: true,
			durationMs: 12,
		});
		const completed = await session.complete();

		process.stdout.write(`${JSON.stringify({
			sessionId: completed.sessionId,
			state: completed.state,
			eventCount: completed.eventCount,
			tokens: completed.tokenUsage,
		}, null, 2)}\n`);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		await session.emitEvent('adapter.lifecycle', {
			adapter: 'demo-product',
			phase: 'request-failed',
			message,
		});
		await session.complete('failed');
		throw error;
	}
}

main().catch((error) => {
	process.stderr.write(`Dummy model run failed: ${error instanceof Error ? error.message : String(error)}\n`);
	process.exitCode = 1;
});
