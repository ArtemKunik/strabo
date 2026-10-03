import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

import {
  computeStringEdges,
  extractCodeEndpoints,
  extractRoutesFromContent,
  extractServiceCalls,
  normalizeRoutePath,
  scanRepository,
} from '../../src/index.ts';

const created: string[] = [];

after(() => {
  for (const directory of created) {
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

function tempDir(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'strabo-routes-'));
  created.push(directory);
  return directory;
}

function write(root: string, file: string, content: string): void {
  const absolute = path.join(root, file);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.writeFileSync(absolute, content);
}

function rows(file: string, content: string): Array<[number, string, string, string | null]> {
  return extractRoutesFromContent(file, content).map((route) => [
    route.line,
    route.method,
    route.path,
    route.handler,
  ]);
}

test('normalizeRoutePath reads every parameter idiom as {name}', () => {
  assert.equal(normalizeRoutePath('/users/:id'), '/users/{id}');
  assert.equal(normalizeRoutePath('/users/:id?/'), '/users/{id}');
  assert.equal(normalizeRoutePath('/users/<int:id>'), '/users/{id}');
  assert.equal(normalizeRoutePath('/users/<id>'), '/users/{id}');
  assert.equal(normalizeRoutePath('api/users/{id:int}'), '/api/users/{id}');
  assert.equal(normalizeRoutePath('/files/{name: [a-z]+}'), '/files/{name}');
  assert.equal(normalizeRoutePath('//a//b?x=1'), '/a/b');
  assert.equal(normalizeRoutePath(''), '/');
});

test('Express routes are read on router receivers, and a client call is not', () => {
  const source = [
    "import express from 'express';",
    'const users = express.Router();',
    "app.get('/health', (req, res) => res.send('ok'));",
    "users.post('/users/:id', auth, updateUser);",
    "axios.get('/users/1', { params });",
    "router.route('/orders').get(listOrders).post(createOrder);",
    "app.get('setting');",
    'app.delete(`/items/${id}`, remove);',
    " * e.g. app.get('/documented', handler);",
    "// app.post('/commented-out', handler);",
  ].join('\n');
  assert.deepEqual(rows('src/server.ts', source), [
    [3, 'GET', '/health', null],
    [4, 'POST', '/users/{id}', 'updateUser'],
    [6, 'GET', '/orders', 'listOrders'],
    [6, 'POST', '/orders', 'createOrder'],
  ]);
});

test('Fastify route objects and NestJS controllers are read', () => {
  const fastify = [
    "fastify.route({ method: ['GET', 'HEAD'], url: '/ping', handler: ping });",
  ].join('\n');
  assert.deepEqual(rows('src/app.js', fastify), [
    [1, 'GET', '/ping', 'ping'],
    [1, 'HEAD', '/ping', 'ping'],
  ]);

  const nest = [
    "@Controller('cats')",
    'export class CatsController {',
    '  @Get()',
    '  findAll(): Cat[] { return []; }',
    '',
    "  @Get(':id')",
    '  @UseGuards(AuthGuard)',
    '  findOne(@Param() params: any) { return params; }',
    '}',
  ].join('\n');
  assert.deepEqual(rows('src/cats.controller.ts', nest), [
    [3, 'GET', '/cats', 'findAll'],
    [6, 'GET', '/cats/{id}', 'findOne'],
  ]);
});

test('FastAPI and Flask decorators are read with a same-file prefix', () => {
  const fastapi = [
    'from fastapi import APIRouter',
    'router = APIRouter(prefix="/items", tags=["items"])',
    '',
    '@router.get("/{item_id}")',
    'async def read_item(item_id: int):',
    '    return {}',
    '',
    '@router.api_route("/", methods=["PUT", "PATCH"])',
    'def upsert():',
    '    pass',
  ].join('\n');
  assert.deepEqual(rows('app/items.py', fastapi), [
    [4, 'GET', '/items/{item_id}', 'read_item'],
    [8, 'PATCH', '/items', 'upsert'],
    [8, 'PUT', '/items', 'upsert'],
  ]);

  const flask = [
    'from flask import Blueprint',
    "bp = Blueprint('users', __name__, url_prefix='/users')",
    '',
    "@bp.route('/<int:user_id>', methods=['GET', 'DELETE'])",
    '@login_required',
    'def user(user_id):',
    '    pass',
    '',
    "@app.route('/')",
    'def index():',
    '    pass',
  ].join('\n');
  const flaskRoutes = extractRoutesFromContent('app/views.py', flask);
  assert.deepEqual(
    flaskRoutes.map((route) => [route.line, route.method, route.path, route.handler, route.framework]),
    [
      [4, 'DELETE', '/users/{user_id}', 'user', 'flask'],
      [4, 'GET', '/users/{user_id}', 'user', 'flask'],
      [9, 'GET', '/', 'index', 'flask'],
    ],
  );
});

test('Spring mappings join the class-level @RequestMapping', () => {
  const java = [
    '@RestController',
    '@RequestMapping("/api/users")',
    'public class UserController {',
    '  @GetMapping("/{id}")',
    '  public ResponseEntity<User> get(@PathVariable("id") long id) { return null; }',
    '',
    '  @PostMapping',
    '  public User create(@RequestBody User user) { return user; }',
    '',
    '  @RequestMapping(value = "/search", method = RequestMethod.GET)',
    '  List<User> search() { return null; }',
    '',
    '  @DeleteMapping(path = {"/{id}", "/by-id/{id}"})',
    '  void remove() {}',
    '}',
  ].join('\n');
  assert.deepEqual(rows('src/main/java/UserController.java', java), [
    [4, 'GET', '/api/users/{id}', 'get'],
    [7, 'POST', '/api/users', 'create'],
    [10, 'GET', '/api/users/search', 'search'],
    [13, 'DELETE', '/api/users/{id}', 'remove'],
    [13, 'DELETE', '/api/users/by-id/{id}', 'remove'],
  ]);

  const kotlin = [
    '@RestController',
    '@RequestMapping("/orders")',
    'class OrderController {',
    '    @GetMapping("/{id}")',
    '    fun get(@PathVariable id: Long): Order = TODO()',
    '}',
  ].join('\n');
  assert.deepEqual(rows('src/OrderController.kt', kotlin), [[4, 'GET', '/orders/{id}', 'get']]);
});

test('JAX-RS verbs join the class @Path and their own @Path', () => {
  const java = [
    '@Path("/books")',
    'public class BookResource {',
    '  @GET',
    '  public List<Book> list() { return null; }',
    '',
    '  @GET',
    '  @Path("{id: \\\\d+}")',
    '  public Book get(@PathParam("id") long id) { return null; }',
    '}',
  ].join('\n');
  assert.deepEqual(rows('src/BookResource.java', java), [
    [3, 'GET', '/books', 'list'],
    [6, 'GET', '/books/{id}', 'get'],
  ]);
});

test('ASP.NET minimal APIs and controller attributes are read', () => {
  const minimal = [
    'var app = builder.Build();',
    'var api = app.MapGroup("/api");',
    'var todos = api.MapGroup("/todos");',
    'app.MapGet("/", () => "Hello");',
    'todos.MapGet("/{id:int}", GetTodo);',
    'todos.MapPost("/", CreateTodo);',
  ].join('\n');
  assert.deepEqual(rows('Program.cs', minimal), [
    [4, 'GET', '/', null],
    [5, 'GET', '/api/todos/{id}', 'GetTodo'],
    [6, 'POST', '/api/todos', 'CreateTodo'],
  ]);

  const controller = [
    '[ApiController]',
    '[Route("api/[controller]")]',
    'public class ProductsController : ControllerBase',
    '{',
    '    [HttpGet]',
    '    public IEnumerable<Product> List() => _db.Products;',
    '',
    '    [HttpGet("{id}")]',
    '    [ProducesResponseType(200)]',
    '    public async Task<ActionResult<Product>> Get(int id) => null;',
    '',
    '    [HttpPost("/v2/products")]',
    '    public IActionResult Create(Product p) => Ok();',
    '}',
  ].join('\n');
  assert.deepEqual(rows('Controllers/ProductsController.cs', controller), [
    [5, 'GET', '/api/Products', 'List'],
    [8, 'GET', '/api/Products/{id}', 'Get'],
    [12, 'POST', '/v2/products', 'Create'],
  ]);
});

test('Axum and Actix routes are read', () => {
  const axum = [
    'let app = Router::new()',
    '    .route("/", get(root))',
    '    .route("/users/:id", get(handlers::show_user).delete(delete_user));',
  ].join('\n');
  const axumRoutes = extractRoutesFromContent('src/main.rs', axum);
  assert.deepEqual(
    axumRoutes.map((route) => [route.line, route.method, route.path, route.handler, route.framework]),
    [
      [2, 'GET', '/', 'root', 'axum'],
      [3, 'DELETE', '/users/{id}', 'delete_user', 'axum'],
      [3, 'GET', '/users/{id}', 'show_user', 'axum'],
    ],
  );

  const actix = [
    '#[get("/hello/{name}")]',
    'async fn greet(name: web::Path<String>) -> impl Responder { name }',
    '',
    'App::new().route("/health", web::get().to(health));',
  ].join('\n');
  assert.deepEqual(rows('src/server.rs', actix), [
    [1, 'GET', '/hello/{name}', 'greet'],
    [4, 'GET', '/health', 'health'],
  ]);
});

test('extractCodeEndpoints records code routes with no host, and calls skip declarations', () => {
  const root = tempDir();
  write(root, 'src/server.ts', "app.get('/users', listUsers);\n");
  write(root, 'app/main.py', '@app.post("/jobs")\ndef create():\n    pass\n');
  write(root, 'src/client.ts', "await fetch('/users');\n");

  const endpoints = extractCodeEndpoints(root, 'svc');
  assert.deepEqual(
    endpoints.map((entry) => [entry.source, entry.line, entry.method, entry.path, entry.host, entry.origin]),
    [
      ['app/main.py', 1, 'POST', '/jobs', null, 'code'],
      ['src/server.ts', 1, 'GET', '/users', null, 'code'],
    ],
  );

  const calls = extractServiceCalls(root);
  assert.deepEqual(
    calls.map((call) => [call.file, call.method, call.path]),
    [['src/client.ts', 'GET', '/users']],
  );
});

test('computeStringEdges joins a literal call to a route declared in code', async () => {
  const root = tempDir();
  write(root, 'src/server.ts', "import { listUsers } from './users';\napp.get('/users/:id', listUsers);\n");
  write(root, 'src/users.ts', 'export function listUsers() {}\n');
  write(root, 'src/client.ts', "export const load = () => fetch('/users/{id}');\n");

  const { graph } = await scanRepository(root);
  const report = await computeStringEdges(root, graph);
  const route = report.routes.find((edge) => edge.key === 'GET /users/{id}');
  assert.ok(route);
  assert.equal(route.declared, true);
  assert.deepEqual(route.declarations, [{ file: 'src/server.ts', line: 2 }]);
  assert.deepEqual(route.readers, [{ file: 'src/client.ts', line: 1 }]);
});

test('routes record the middleware, decorators, and attributes in front of the handler', () => {
  const middleware = (file: string, content: string) =>
    extractRoutesFromContent(file, content).map((route) => [route.method, route.path, route.middleware]);

  assert.deepEqual(
    middleware(
      'src/server.ts',
      [
        "app.get('/me', requireAuth, passport.authenticate('jwt', { session: false }), [audit, rateLimit], me);",
        "app.get('/open', (req, res) => res.send('ok'));",
      ].join('\n'),
    ),
    [
      ['GET', '/me', ['requireAuth', 'passport.authenticate()', 'audit', 'rateLimit']],
      ['GET', '/open', []],
    ],
  );

  assert.deepEqual(
    middleware(
      'app/main.py',
      [
        '@app.get("/me", dependencies=[Depends(verify_key)])',
        '@login_required',
        'async def me(user = Depends(current_user)):',
        '    return user',
      ].join('\n'),
    ),
    [['GET', '/me', ['login_required', 'Depends(verify_key)', 'Depends(current_user)']]],
  );

  assert.deepEqual(
    middleware(
      'src/cats.controller.ts',
      [
        "@Controller('cats')",
        '@UseGuards(AuthGuard)',
        'export class CatsController {',
        "  @Get(':id')",
        "  @Roles('admin')",
        '  findOne() {}',
        '}',
      ].join('\n'),
    ),
    [['GET', '/cats/{id}', ['Roles(admin)', 'UseGuards(AuthGuard)']]],
  );

  assert.deepEqual(
    middleware(
      'Controllers/OrdersController.cs',
      [
        '[Authorize]',
        '[Route("api/orders")]',
        'public class OrdersController : ControllerBase',
        '{',
        '    [HttpGet]',
        '    [AllowAnonymous]',
        '    public IActionResult List() => Ok();',
        '}',
      ].join('\n'),
    ),
    [['GET', '/api/orders', ['AllowAnonymous', 'Authorize']]],
  );

  assert.deepEqual(
    middleware('Program.cs', 'app.MapGet("/admin", Admin).RequireAuthorization("admin");'),
    [['GET', '/admin', ['RequireAuthorization']]],
  );

  assert.deepEqual(
    middleware(
      'src/UserController.java',
      [
        '@RestController',
        '@PreAuthorize("hasRole(\'USER\')")',
        'public class UserController {',
        '  @GetMapping("/me")',
        '  @Secured("ROLE_ADMIN")',
        '  public User me() { return null; }',
        '}',
      ].join('\n'),
    ),
    [['GET', '/me', ['Secured(ROLE_ADMIN)', 'PreAuthorize']]],
  );
});
