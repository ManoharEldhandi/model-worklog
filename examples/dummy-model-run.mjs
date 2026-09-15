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
		await session.userMessage(prompt);
		await session.plan('Check the service status, inspect the implementation, then summarize the result.', [
			'Check product status',
			'Review the health implementation',
			'Run the product check',
			'Summarize the observable result',
		]);
		await session.reasoningSummary('The status result and the current health implementation are sufficient to produce a concise review.');

		const status = await session.runTool({
			tool: 'get_product_status',
			arguments: { scope: 'demo' },
			correlationId: 'tool_product_status_001',
		}, async () => ({ status: 'healthy', checkedServices: 3 }));
		await session.fileRead({ path: 'src/health.ts', tool: 'read_file', correlationId: 'tool_read_health_001' });
		await session.runTool({
			tool: 'read_file',
			arguments: { path: 'src/health.ts', lineRange: [1, 120] },
			correlationId: 'tool_read_health_001',
		}, async () => ({ linesRead: 48, exportedFunction: 'buildHealthResponse' }));
		await session.fileChanged({ path: 'docs/product-health.md', operation: 'modified', correlationId: 'tool_update_docs_001' });
		await session.commandStarted({ executable: 'npm', args: ['test', '--', 'health'], correlationId: 'command_health_001' });
		await session.commandCompleted({ executable: 'npm', args: ['test', '--', 'health'], exitCode: 0, correlationId: 'command_health_001' });

		const result = await runDummyModel(prompt);
		await session.summary(`${result.answer} Product status: ${status.status}; services checked: ${status.checkedServices}.`);
		await session.reportProviderUsage('openai', result.providerResponse);
		await session.testCompleted({
			name: 'dummy-model-response-check',
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
