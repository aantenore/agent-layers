/** A small OpenAPI 3 document that exercises parameters, bodies and references, pointed at `server`. */
export function sampleSpec(server: string): Record<string, any> {
  return {
    openapi: '3.0.3',
    info: { title: 'sample', version: '1' },
    servers: [{ url: server }],
    paths: {
      '/echo': {
        get: {
          operationId: 'echoQuery',
          summary: 'Echo the query',
          parameters: [
            { name: 'message', in: 'query', required: true, description: 'Text to echo', schema: { type: 'string' } },
            { name: 'tag', in: 'query', schema: { type: 'array', items: { type: 'string' } } },
            { name: 'x-trace', in: 'header', schema: { type: 'string' } },
            { name: 'Authorization', in: 'header', schema: { type: 'string' } },
          ],
          responses: { 200: { description: 'ok' } },
        },
        post: {
          operationId: 'echoJson',
          requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/Note' } } } },
          responses: { 200: { description: 'ok' } },
        },
        delete: { operationId: 'wipeEcho', responses: { 204: { description: 'gone' } } },
      },
      '/status/{code}': {
        parameters: [{ name: 'code', in: 'path', required: true, schema: { type: 'integer', minimum: 100, maximum: 599 } }],
        get: { operationId: 'getStatus', description: 'Answer with the status', responses: { default: { description: 'any' } } },
      },
      '/text/{value}': {
        get: { parameters: [{ $ref: '#/components/parameters/Value' }], responses: { 200: { description: 'text' } } },
      },
      '/array': {
        put: { operationId: 'putArray', requestBody: { content: { 'application/json': { schema: { type: 'array', items: { type: 'integer' } } } } }, responses: { 200: { description: 'ok' } } },
      },
      '/upload': {
        post: { operationId: 'upload', requestBody: { content: { 'multipart/form-data': { schema: { type: 'object' } } } }, responses: { 200: { description: 'ok' } } },
      },
    },
    components: {
      parameters: { Value: { name: 'value', in: 'path', required: true, schema: { type: 'string' } } },
      schemas: {
        Note: {
          type: 'object',
          required: ['title'],
          properties: { title: { type: 'string' }, tags: { type: 'array', items: { type: 'string' } }, parent: { $ref: '#/components/schemas/Note' }, due: { type: 'string', nullable: true } },
        },
      },
    },
  };
}
