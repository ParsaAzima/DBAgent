import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const server = new Server(
  { name: 'dbagent-test-server', version: '1.0.0' },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'echo',
      description: 'Return the supplied message.',
      inputSchema: {
        type: 'object',
        properties: {
          message: { type: 'string', description: 'Message to echo.' },
          labels: { type: 'array', items: { type: 'string' } },
        },
        required: ['message'],
      },
    },
    {
      name: 'fail',
      description: 'Return a tool error.',
      inputSchema: { type: 'object', properties: {} },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  if (request.params.name === 'fail') {
    return { isError: true, content: [{ type: 'text', text: 'expected test error' }] };
  }
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify({
          message: request.params.arguments?.message,
          labels: request.params.arguments?.labels,
        }),
      },
    ],
  };
});

await server.connect(new StdioServerTransport());
