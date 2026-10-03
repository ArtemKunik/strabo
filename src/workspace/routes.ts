import path from 'node:path';

/**
 * HTTP routes a repository declares in its own source, read lexically per framework.
 *
 * OpenAPI documents are one place a route is declared; the handler registration is the other,
 * and most repositories have only that. Each reader below recognises one registration idiom and
 * records `METHOD /path` with the declaring line and, when it is named, the handler. It reads
 * no AST, so a route is recorded only when its path is a string literal in the file:
 *
 * - **JS/TS**: Express, Fastify, Koa Router, and Hono verb calls (`app.get('/x', h)`) on a
 *   receiver named like a router or built from a router factory in the same file;
 *   `router.route('/x').get(h)` chains; `fastify.route({ method, url })`; NestJS
 *   `@Controller` + `@Get(':id')`.
 * - **Python**: FastAPI and Flask decorators (`@app.get`, `@bp.route(methods=[...])`), with a
 *   same-file `APIRouter(prefix=)` / `Blueprint(url_prefix=)` prefix.
 * - **Java/Kotlin**: Spring `@GetMapping` and `@RequestMapping(method=)`, and JAX-RS `@GET` +
 *   `@Path`, under the class-level mapping.
 * - **C#**: ASP.NET minimal APIs (`MapGet`, with a same-file `MapGroup` prefix) and controller
 *   attributes (`[HttpGet("{id}")]` under `[Route("api/[controller]")]`).
 * - **Rust**: Axum and Actix `.route("/x", get(h))` and Actix `#[get("/x")]` macros.
 *
 * A prefix applied from another file (an Express `app.use('/api', router)`, a FastAPI
 * `include_router(prefix=)`, an Axum `nest`) is not followed, so such a route is recorded at
 * the path its own file declares. Path parameters are normalised to the OpenAPI `{name}` form
 * (`:id`, `<int:id>`, `{id:int}` all read `{id}`) so a code route and a spec route compare.
 */

export interface CodeRoute {
  file: string;
  line: number;
  /** Uppercase HTTP method. */
  method: string;
  /** Normalised path, parameters in `{name}` form. */
  path: string;
  framework: string;
  /** The handler the route names, when it is a plain identifier or the decorated function. */
  handler: string | null;
  /**
   * What runs in front of the handler, as written: Express middleware arguments, the other
   * decorators, annotations, or attributes on the handler and its class (`login_required`,
   * `UseGuards(AuthGuard)`, `Authorize`), FastAPI `Depends(...)`, and ASP.NET
   * `RequireAuthorization`. Global middleware (`app.use(auth)`) is not followed.
   */
  middleware: string[];
  /** Offsets of the registration text, so the call reader can tell it is not a call. */
  start: number;
  end: number;
}

/** A route as a reader records it; the shared pass fills in what runs in front of it. */
type RawRoute = Omit<CodeRoute, 'middleware'> & { middleware?: string[] };

const VERBS = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options'] as const;
const VERB_SET = new Set<string>(VERBS);
const MAX_ARGUMENT_SCAN = 4000;

/** Read the routes one already-read file declares, by its extension. */
export function extractRoutesFromContent(file: string, content: string): CodeRoute[] {
  const extension = path.extname(file).toLowerCase();
  const lines = lineStarts(content);
  let routes: RawRoute[];
  switch (extension) {
    case '.js':
    case '.jsx':
    case '.mjs':
    case '.cjs':
    case '.ts':
    case '.tsx':
    case '.mts':
    case '.cts':
      routes = [...javascriptRoutes(file, content, lines), ...nestRoutes(file, content, lines)];
      break;
    case '.py':
      routes = pythonRoutes(file, content, lines);
      break;
    case '.java':
    case '.kt':
    case '.kts':
      routes = [...springRoutes(file, content, lines), ...jaxRsRoutes(file, content, lines)];
      break;
    case '.cs':
      routes = [...minimalApiRoutes(file, content, lines), ...aspNetControllerRoutes(file, content, lines)];
      break;
    case '.rs':
      routes = rustRoutes(file, content, lines);
      break;
    default:
      routes = [];
  }
  return dedupeRoutes(
    routes
      .filter((route) => !onCommentLine(content, route.start))
      .map((route) => ({ ...route, middleware: unique([...(route.middleware ?? []), ...middlewareAround(content, route)]) })),
  );
}

/** Frameworks whose guards are decorators, annotations, or attributes beside the handler. */
const DECORATED = new Set(['nestjs', 'fastapi', 'flask', 'spring', 'jax-rs', 'aspnet', 'actix']);
/** The route-declaring annotations themselves, which are not middleware. */
const ROUTE_ANNOTATION =
  /^(?:(?:Get|Post|Put|Patch|Delete|Request)Mapping|Http(?:Get|Post|Put|Patch|Delete|Head|Options)|Route|Path|GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS|Get|Post|Put|Patch|Delete|Head|Options|All|Controller|RestController|ApiController|get|post|put|patch|delete|head|options|route)$|\.(?:get|post|put|patch|delete|head|options|route|api_route)$/;

/**
 * The decorators, annotations, and attributes on a decorated route's handler and its class,
 * FastAPI dependencies, and an ASP.NET minimal route's `.RequireAuthorization()` chain.
 */
function middlewareAround(content: string, route: RawRoute): string[] {
  const found: string[] = [];
  if (route.framework === 'aspnet') {
    const chain = /^(?:\s*\.\s*(RequireAuthorization|AllowAnonymous|RequireRateLimiting|RequireCors)\s*\([^)]*\))+/.exec(
      content.slice(route.end, route.end + 400),
    );
    for (const link of chain?.[0].matchAll(/\.\s*(\w+)\s*\(/g) ?? []) {
      found.push(link[1] ?? '');
    }
  }
  if (!DECORATED.has(route.framework)) {
    return found;
  }
  const block = annotationBlock(content, route.start);
  found.push(...annotationsIn(content.slice(block.start, block.end)));
  const type = lastTypeDeclarationBefore(content, route.start);
  if (type !== -1) {
    const classBlock = annotationBlock(content, type);
    found.push(...annotationsIn(content.slice(classBlock.start, type)));
  }
  if (route.framework === 'fastapi') {
    const signatureEnd = content.indexOf(':\n', route.end);
    const scope = content.slice(route.start, signatureEnd === -1 ? route.end + 600 : signatureEnd);
    for (const dependency of scope.matchAll(/\b(Depends|Security)\s*\(\s*([\w.]+)/g)) {
      found.push(`${dependency[1]}(${dependency[2]})`);
    }
  }
  return found;
}

/** `@Name`, `@Name(args)`, `[Name]`, and `[Name(args)]`, minus the route annotations. */
function annotationsIn(text: string): string[] {
  const names: string[] = [];
  const add = (name: string, args: string | undefined) => {
    if (ROUTE_ANNOTATION.test(name)) {
      return;
    }
    const identifiers = args?.match(/[A-Za-z_][\w.]*/g)?.filter((word) => !/^(value|path|name)$/.test(word)) ?? [];
    names.push(identifiers.length > 0 ? `${name}(${identifiers.slice(0, 3).join(', ')})` : name);
  };
  for (const match of text.matchAll(/@\s*([A-Za-z_][\w.]*)(?:\s*\(([^()\n]{0,120})\))?/g)) {
    add(match[1] ?? '', match[2]);
  }
  for (const match of text.matchAll(/[[,]\s*([A-Z]\w*)(?:\s*\(([^()\n]{0,120})\))?\s*(?=[\],])/g)) {
    add(match[1] ?? '', match[2]);
  }
  return names;
}

function lastTypeDeclarationBefore(content: string, offset: number): number {
  let found = -1;
  for (const match of content.slice(0, offset).matchAll(/\b(?:class|interface|object|record)\s+\w+/g)) {
    found = match.index ?? found;
  }
  return found;
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values.filter((value) => value !== ''))];
}

/** A registration quoted in a `//`, `#`, or block-comment line is documentation, not a route. */
function onCommentLine(content: string, offset: number): boolean {
  const lineStart = content.lastIndexOf('\n', offset - 1) + 1;
  const head = content.slice(lineStart, offset).trimStart();
  return /^(\/\/|\/?\*|#(?!\[))/.test(head);
}

// ---------------------------------------------------------------------------------------------
// JavaScript / TypeScript

/** Receivers a route registration is conventionally made on. */
const JS_ROUTER_NAMES = new Set(['app', 'router', 'server', 'fastify', 'hono', 'routes', 'api_router', 'apiRouter']);
/** `const users = express.Router()` and its siblings name a receiver in the same file. */
const JS_ROUTER_FACTORY =
  /\b(?:const|let|var)\s+(\w+)\s*(?::[^=\n]+)?=\s*(?:await\s+)?(?:express\s*\(|express\.Router\s*\(|Router\s*\(|[Ff]astify\s*\(|new\s+(?:Hono|Router|KoaRouter|Elysia)\b)/g;
const JS_VERB_ROUTE =
  /\b((?:this\.)?[A-Za-z_$][\w$]*)\s*\.\s*(get|post|put|patch|delete|head|options)\s*\(\s*(['"`])(\/[^'"`\n]*)\3\s*,/g;
const JS_ROUTE_CHAIN = /\b((?:this\.)?[A-Za-z_$][\w$]*)\s*\.\s*route\s*\(\s*(['"`])(\/[^'"`\n]*)\2\s*\)/g;
const JS_ROUTE_OBJECT = /\b((?:this\.)?[A-Za-z_$][\w$]*)\s*\.\s*route\s*\(\s*\{/g;

function javascriptRoutes(file: string, content: string, lines: number[]): RawRoute[] {
  const receivers = new Set(JS_ROUTER_NAMES);
  for (const match of content.matchAll(JS_ROUTER_FACTORY)) {
    receivers.add(match[1] ?? '');
  }
  const isRouter = (receiver: string): boolean => receivers.has(receiver.replace(/^this\./, ''));
  const routes: RawRoute[] = [];

  for (const match of content.matchAll(JS_VERB_ROUTE)) {
    const receiver = match[1] ?? '';
    const rawPath = match[4] ?? '';
    if (!isRouter(receiver) || rawPath.includes('${')) {
      continue;
    }
    const start = match.index ?? 0;
    const argumentsEnd = closingParen(content, start + match[0].indexOf('('));
    const { handler, middleware } = handlerArguments(content.slice(start + match[0].length, argumentsEnd));
    routes.push({
      file,
      line: lineAt(lines, start),
      method: (match[2] ?? '').toUpperCase(),
      path: normalizeRoutePath(rawPath),
      framework: 'express',
      handler,
      middleware,
      start,
      end: argumentsEnd + 1,
    });
  }

  // `router.route('/users').get(list).post(create)`
  for (const match of content.matchAll(JS_ROUTE_CHAIN)) {
    const receiver = match[1] ?? '';
    const rawPath = match[3] ?? '';
    if (!isRouter(receiver) || rawPath.includes('${')) {
      continue;
    }
    const start = match.index ?? 0;
    let cursor = start + match[0].length;
    for (;;) {
      const link = /^\s*\.\s*(\w+)\s*\(/.exec(content.slice(cursor, cursor + 200));
      if (!link || !VERB_SET.has(link[1] ?? '')) {
        break;
      }
      const open = cursor + link[0].length - 1;
      const close = closingParen(content, open);
      const { handler, middleware } = handlerArguments(content.slice(open + 1, close));
      routes.push({
        file,
        line: lineAt(lines, cursor + link[0].indexOf(link[1] ?? '')),
        method: (link[1] ?? '').toUpperCase(),
        path: normalizeRoutePath(rawPath),
        framework: 'express',
        handler,
        middleware,
        start,
        end: close + 1,
      });
      cursor = close + 1;
    }
  }

  // `fastify.route({ method: 'GET', url: '/users', handler })`
  for (const match of content.matchAll(JS_ROUTE_OBJECT)) {
    if (!isRouter(match[1] ?? '')) {
      continue;
    }
    const start = match.index ?? 0;
    const open = start + match[0].lastIndexOf('(');
    const close = closingParen(content, open);
    const body = content.slice(open + 1, close);
    const url = /\b(?:url|path)\s*:\s*(['"`])(\/[^'"`\n]*)\1/.exec(body);
    const methods = readMethodList(/\bmethod\s*:\s*(\[[^\]]*\]|(['"`])\w+\2)/.exec(body)?.[1] ?? '');
    if (!url || url[2]?.includes('${') || methods.length === 0) {
      continue;
    }
    const handler = /\bhandler\s*(?::\s*([A-Za-z_$][\w$.]*)\s*[,}\n]|[,}\n])/.exec(body);
    for (const method of methods) {
      routes.push({
        file,
        line: lineAt(lines, start),
        method,
        path: normalizeRoutePath(url[2] ?? ''),
        framework: 'fastify',
        handler: handler ? (handler[1] ?? 'handler') : null,
        start,
        end: close + 1,
      });
    }
  }
  return routes;
}

const NEST_CONTROLLER = /@Controller\s*\(\s*(?:(['"`])([^'"`\n]*)\1|\{[^}]*\bpath\s*:\s*(['"`])([^'"`\n]*)\3[^}]*\})?/;
const NEST_METHOD = /@(Get|Post|Put|Patch|Delete|Head|Options)\s*\(\s*(?:(['"`])([^'"`\n]*)\2)?\s*\)/g;

function nestRoutes(file: string, content: string, lines: number[]): RawRoute[] {
  const controller = NEST_CONTROLLER.exec(content);
  if (!controller) {
    return [];
  }
  const prefix = controller[2] ?? controller[4] ?? '';
  const routes: RawRoute[] = [];
  for (const match of content.matchAll(NEST_METHOD)) {
    const rawPath = match[3] ?? '';
    if (rawPath.includes('${')) {
      continue;
    }
    const start = match.index ?? 0;
    const end = start + match[0].length;
    routes.push({
      file,
      line: lineAt(lines, start),
      method: (match[1] ?? '').toUpperCase(),
      path: joinRoutePath(prefix, rawPath),
      framework: 'nestjs',
      handler: declaredNameAfter(content, end),
      start,
      end,
    });
  }
  return routes;
}

// ---------------------------------------------------------------------------------------------
// Python

const PY_DECORATOR =
  /^[ \t]*@[ \t]*([\w.]+)\.(get|post|put|patch|delete|head|options|route|api_route)[ \t]*\(\s*(?:path\s*=\s*|rule\s*=\s*)?r?(['"])([^'"\n]*)\3/gm;
const PY_PREFIX = /^[ \t]*(\w+)\s*=\s*(APIRouter|Blueprint)\s*\(/gm;

function pythonRoutes(file: string, content: string, lines: number[]): RawRoute[] {
  const prefixes = new Map<string, string>();
  for (const match of content.matchAll(PY_PREFIX)) {
    const open = (match.index ?? 0) + match[0].length - 1;
    const args = content.slice(open + 1, closingParen(content, open));
    const keyword = match[2] === 'APIRouter' ? 'prefix' : 'url_prefix';
    const prefix = new RegExp(`\\b${keyword}\\s*=\\s*r?(['"])([^'"\\n]*)\\1`).exec(args);
    if (prefix) {
      prefixes.set(match[1] ?? '', prefix[2] ?? '');
    }
  }

  const routes: RawRoute[] = [];
  for (const match of content.matchAll(PY_DECORATOR)) {
    const receiver = match[1] ?? '';
    const kind = match[2] ?? '';
    const start = (match.index ?? 0) + (match[0].length - match[0].trimStart().length);
    const open = (match.index ?? 0) + match[0].indexOf('(');
    const close = closingParen(content, open);
    const args = content.slice(open + 1, close);
    let methods: string[];
    if (kind === 'route' || kind === 'api_route') {
      const listed = /\bmethods\s*=\s*([[(][^\])]*[\])])/.exec(args);
      methods = listed ? readMethodList(listed[1] ?? '') : ['GET'];
    } else {
      methods = [kind.toUpperCase()];
    }
    const prefix = prefixes.get(receiver.split('.').pop() ?? receiver) ?? '';
    const routePath = joinRoutePath(prefix, match[4] ?? '');
    const handler = declaredNameAfter(content, close + 1);
    const framework = /\bfrom\s+flask\b|\bimport\s+flask\b/.test(content) ? 'flask' : 'fastapi';
    for (const method of methods) {
      routes.push({
        file,
        line: lineAt(lines, start),
        method,
        path: routePath,
        framework,
        handler,
        start,
        end: close + 1,
      });
    }
  }
  return routes;
}

// ---------------------------------------------------------------------------------------------
// Java / Kotlin

const SPRING_MAPPING = /@(Get|Post|Put|Patch|Delete|Request)Mapping\b/g;
const JAXRS_VERB = /@(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\b(?!\s*\()/g;
const TYPE_DECLARATION = /\b(?:class|interface|object|record)\s+(\w+)/;

function springRoutes(file: string, content: string, lines: number[]): RawRoute[] {
  const typeIndex = TYPE_DECLARATION.exec(content)?.index ?? -1;
  let prefix = '';
  const routes: RawRoute[] = [];
  for (const match of content.matchAll(SPRING_MAPPING)) {
    const start = match.index ?? 0;
    const annotation = readAnnotationArguments(content, start + match[0].length);
    const paths = annotationPaths(annotation.args);
    if (typeIndex !== -1 && start < typeIndex) {
      if (match[1] === 'Request') {
        prefix = paths[0] ?? '';
      }
      continue;
    }
    const methods =
      match[1] === 'Request'
        ? [...(annotation.args ?? '').matchAll(/\bRequestMethod\.(\w+)/g)].map((entry) => (entry[1] ?? '').toUpperCase())
        : [(match[1] ?? '').toUpperCase()];
    const handler = declaredNameAfter(content, annotation.end);
    for (const method of methods) {
      for (const rawPath of paths.length > 0 ? paths : ['']) {
        routes.push({
          file,
          line: lineAt(lines, start),
          method,
          path: joinRoutePath(prefix, rawPath),
          framework: 'spring',
          handler,
          start,
          end: annotation.end,
        });
      }
    }
  }
  return routes;
}

function jaxRsRoutes(file: string, content: string, lines: number[]): RawRoute[] {
  if (!/@Path\s*\(/.test(content)) {
    return [];
  }
  const typeIndex = TYPE_DECLARATION.exec(content)?.index ?? content.length;
  const classPath = /@Path\s*\(\s*(?:value\s*=\s*)?"([^"\n]*)"/.exec(content.slice(0, typeIndex))?.[1] ?? '';
  const routes: RawRoute[] = [];
  for (const match of content.matchAll(JAXRS_VERB)) {
    const start = match.index ?? 0;
    if (start < typeIndex) {
      continue;
    }
    const block = annotationBlock(content, start);
    const methodPath = /@Path\s*\(\s*(?:value\s*=\s*)?"([^"\n]*)"/.exec(content.slice(block.start, block.end))?.[1] ?? '';
    routes.push({
      file,
      line: lineAt(lines, start),
      method: match[1] ?? '',
      path: joinRoutePath(classPath, methodPath),
      framework: 'jax-rs',
      handler: declaredNameAfter(content, start + match[0].length),
      start,
      end: start + match[0].length,
    });
  }
  return routes;
}

/** The string paths an annotation's arguments name: positional, `value =`, or `path =`. */
function annotationPaths(args: string | null): string[] {
  if (args === null) {
    return [];
  }
  const trimmed = args.trim();
  let at = /^["{[]/.test(trimmed) ? 0 : -1;
  if (at === -1) {
    const named = /\b(?:value|path)\s*=\s*/.exec(trimmed);
    at = named ? named.index + named[0].length : -1;
  }
  if (at === -1) {
    return [];
  }
  // A single literal, or a `{...}` (Java) / `[...]` (Kotlin) array of them.
  const opener = trimmed[at];
  const source =
    opener === '{' || opener === '['
      ? trimmed.slice(at, closingDelimiter(trimmed, at, opener, opener === '{' ? '}' : ']') + 1)
      : (/^"[^"\n]*"/.exec(trimmed.slice(at))?.[0] ?? '');
  return [...source.matchAll(/"([^"\n]*)"/g)].map((entry) => entry[1] ?? '');
}

// ---------------------------------------------------------------------------------------------
// C#

const MINIMAL_MAP = /\b(\w+)\s*\.\s*Map(Get|Post|Put|Patch|Delete)\s*\(\s*@?"([^"\n]*)"/g;
const MINIMAL_GROUP = /\b(?:var|[\w<>]+)\s+(\w+)\s*=\s*(\w+)\s*\.\s*MapGroup\s*\(\s*@?"([^"\n]*)"\s*\)/g;
const HTTP_ATTRIBUTE = /\[\s*Http(Get|Post|Put|Patch|Delete|Head|Options)\s*(?:\(\s*(?:template\s*:\s*)?@?"([^"\n]*)"[^)]*\))?\s*[\],]/g;

function minimalApiRoutes(file: string, content: string, lines: number[]): RawRoute[] {
  const groups = new Map<string, { parent: string; path: string }>();
  for (const match of content.matchAll(MINIMAL_GROUP)) {
    groups.set(match[1] ?? '', { parent: match[2] ?? '', path: match[3] ?? '' });
  }
  const prefixOf = (receiver: string, depth = 0): string => {
    const group = groups.get(receiver);
    return group && depth < 8 ? joinRoutePath(prefixOf(group.parent, depth + 1), group.path) : '';
  };
  const routes: RawRoute[] = [];
  for (const match of content.matchAll(MINIMAL_MAP)) {
    const start = match.index ?? 0;
    const open = start + match[0].indexOf('(');
    const close = closingParen(content, open);
    const rest = content.slice(start + match[0].length, close);
    routes.push({
      file,
      line: lineAt(lines, start),
      method: (match[2] ?? '').toUpperCase(),
      path: joinRoutePath(prefixOf(match[1] ?? ''), match[3] ?? ''),
      framework: 'aspnet',
      handler: lastIdentifierArgument(rest),
      start,
      end: close + 1,
    });
  }
  return routes;
}

function aspNetControllerRoutes(file: string, content: string, lines: number[]): RawRoute[] {
  const type = /\bclass\s+(\w+)/.exec(content);
  if (!type || !HTTP_ATTRIBUTE.test(content)) {
    return [];
  }
  HTTP_ATTRIBUTE.lastIndex = 0;
  const typeIndex = type.index;
  const controller = (type[1] ?? '').replace(/Controller$/, '');
  const classRoute = /\[\s*Route\s*\(\s*@?"([^"\n]*)"/.exec(content.slice(0, typeIndex))?.[1] ?? '';
  const routes: RawRoute[] = [];
  for (const match of content.matchAll(HTTP_ATTRIBUTE)) {
    const start = match.index ?? 0;
    if (start < typeIndex) {
      continue;
    }
    const block = annotationBlock(content, start);
    const handler = declaredNameAfter(content, start + match[0].length);
    let template = match[2];
    if (template === undefined) {
      template = /\[\s*Route\s*\(\s*@?"([^"\n]*)"/.exec(content.slice(block.start, block.end))?.[1] ?? '';
    }
    const absolute = template.startsWith('/') || template.startsWith('~/');
    const joined = absolute ? template.replace(/^~/, '') : joinRoutePath(classRoute, template);
    const routePath = joined
      .replace(/\[controller\]/gi, controller)
      .replace(/\[action\]/gi, handler ?? '[action]');
    routes.push({
      file,
      line: lineAt(lines, start),
      method: (match[1] ?? '').toUpperCase(),
      path: normalizeRoutePath(routePath),
      framework: 'aspnet',
      handler,
      start,
      end: start + match[0].length,
    });
  }
  return routes;
}

// ---------------------------------------------------------------------------------------------
// Rust

const RUST_ROUTE = /\.\s*route\s*\(\s*"([^"\n]*)"\s*,/g;
const RUST_METHOD_MACRO = /#\[\s*(get|post|put|patch|delete|head|options)\s*\(\s*"([^"\n]*)"/g;
const RUST_ROUTE_MACRO = /#\[\s*route\s*\(\s*"([^"\n]*)"([^\]]*)\]/g;

function rustRoutes(file: string, content: string, lines: number[]): RawRoute[] {
  const routes: RawRoute[] = [];
  for (const match of content.matchAll(RUST_ROUTE)) {
    const start = match.index ?? 0;
    const open = start + match[0].indexOf('(');
    const close = closingParen(content, open);
    const args = content.slice(start + match[0].length, close);
    const actix = /\bweb::/.test(args);
    for (const verb of args.matchAll(/(?:^|\W)(?:\w+::)*(get|post|put|patch|delete|head|options)\s*\(\s*([\w:]*)\s*\)/g)) {
      let handler = verb[2] ? (verb[2].split('::').pop() ?? null) : null;
      if (handler === null) {
        const to = /\.\s*to\s*\(\s*([\w:]+)\s*\)/.exec(args.slice((verb.index ?? 0) + verb[0].length));
        handler = to?.[1]?.split('::').pop() ?? null;
      }
      routes.push({
        file,
        line: lineAt(lines, start),
        method: (verb[1] ?? '').toUpperCase(),
        path: normalizeRoutePath(match[1] ?? ''),
        framework: actix ? 'actix' : 'axum',
        handler,
        start,
        end: close + 1,
      });
    }
  }
  for (const match of content.matchAll(RUST_METHOD_MACRO)) {
    const start = match.index ?? 0;
    const end = start + match[0].length;
    routes.push({
      file,
      line: lineAt(lines, start),
      method: (match[1] ?? '').toUpperCase(),
      path: normalizeRoutePath(match[2] ?? ''),
      framework: 'actix',
      handler: declaredNameAfter(content, closingBracket(content, start + 1) + 1),
      start,
      end,
    });
  }
  for (const match of content.matchAll(RUST_ROUTE_MACRO)) {
    const start = match.index ?? 0;
    const methods = [...(match[2] ?? '').matchAll(/\bmethod\s*=\s*"(\w+)"/g)].map((entry) => (entry[1] ?? '').toUpperCase());
    for (const method of methods) {
      routes.push({
        file,
        line: lineAt(lines, start),
        method,
        path: normalizeRoutePath(match[1] ?? ''),
        framework: 'actix',
        handler: declaredNameAfter(content, start + match[0].length),
        start,
        end: start + match[0].length,
      });
    }
  }
  return routes;
}

// ---------------------------------------------------------------------------------------------
// Shared helpers

/**
 * Normalise a declared route path to the OpenAPI `{name}` form.
 *
 * `:id` and `:id?` (Express, Axum 0.7), `<id>` and `<int:id>` (Flask), and `{id:int}` /
 * `{id: \d+}` (ASP.NET, JAX-RS) all become `{id}`; a query or fragment is dropped, slashes
 * collapse, and a trailing slash is trimmed.
 */
export function normalizeRoutePath(value: string): string {
  let normalized = (value.split(/[?#]/)[0] ?? value)
    .replace(/(^|\/):(\w+)\??/g, '$1{$2}')
    .replace(/<(?:\w+:)?(\w+)>/g, '{$1}')
    .replace(/\{\*?(\w+)\s*[:=][^}]*\}/g, '{$1}');
  if (!normalized.startsWith('/')) {
    normalized = `/${normalized}`;
  }
  normalized = normalized.replace(/\/{2,}/g, '/');
  if (normalized.length > 1) {
    normalized = normalized.replace(/\/+$/, '');
  }
  return normalized;
}

function joinRoutePath(prefix: string, routePath: string): string {
  const head = prefix.replace(/\/+$/, '');
  const tail = routePath.replace(/^\/+/, '');
  return normalizeRoutePath(tail === '' ? head : `${head}/${tail}`);
}

/** Uppercase verbs from a `['GET', 'POST']`, `("GET",)`, or `'GET'` literal. */
function readMethodList(source: string): string[] {
  return [...source.matchAll(/(['"`])(\w+)\1/g)]
    .map((entry) => (entry[2] ?? '').toUpperCase())
    .filter((method) => VERB_SET.has(method.toLowerCase()));
}

/**
 * The handler and middleware of a verb registration's remaining arguments: the last argument
 * is the handler when it is a plain name; each earlier one is middleware, read as its name or
 * its callee (`passport.authenticate()`), and an array of them is read element by element.
 */
function handlerArguments(rest: string): { handler: string | null; middleware: string[] } {
  const parts = splitTopLevel(rest);
  const last = parts[parts.length - 1] ?? '';
  const handler = /^[A-Za-z_$][\w$.]*$/.test(last) ? (last.split('.').pop() ?? null) : null;
  const middleware: string[] = [];
  const read = (part: string): void => {
    if (part.startsWith('[') && part.endsWith(']')) {
      splitTopLevel(part.slice(1, -1)).forEach(read);
    } else if (/^[A-Za-z_$][\w$.]*$/.test(part)) {
      middleware.push(part);
    } else {
      const callee = /^([A-Za-z_$][\w$.]*)\s*\(/.exec(part)?.[1];
      if (callee && !/^(async|function)$/.test(callee)) {
        middleware.push(`${callee}()`);
      }
    }
  };
  parts.slice(0, -1).forEach(read);
  return { handler, middleware };
}

/** Split an argument list at its top-level commas, skipping nested brackets and strings. */
function splitTopLevel(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index] ?? '';
    if (char === '"' || char === "'" || char === '`') {
      const close = text.indexOf(char, index + 1);
      const end = close === -1 ? text.length - 1 : close;
      current += text.slice(index, end + 1);
      index = end;
      continue;
    }
    if ('([{'.includes(char)) {
      depth += 1;
    } else if (')]}'.includes(char)) {
      depth -= 1;
    } else if (char === ',' && depth === 0) {
      parts.push(current.trim());
      current = '';
      continue;
    }
    current += char;
  }
  parts.push(current.trim());
  return parts.filter((part) => part !== '');
}

/** The handler when a registration's remaining arguments are all plain identifiers. */
function lastIdentifierArgument(rest: string): string | null {
  const parts = rest.split(',').map((part) => part.trim()).filter((part) => part !== '');
  if (parts.length === 0 || !parts.every((part) => /^[A-Za-z_$][\w$.]*$/.test(part))) {
    return null;
  }
  return parts[parts.length - 1]?.split('.').pop() ?? null;
}

/**
 * The name of the function or method declared after `from`, past any further decorators,
 * annotations, attributes, and comments: `def name(`, `fn name(`, `public X name(`.
 */
function declaredNameAfter(content: string, from: number): string | null {
  let index = from;
  const limit = Math.min(content.length, from + MAX_ARGUMENT_SCAN);
  while (index < limit) {
    const char = content[index] ?? '';
    if (/\s/.test(char)) {
      index += 1;
    } else if (content.startsWith('//', index) || (char === '#' && content[index + 1] !== '[')) {
      const newline = content.indexOf('\n', index);
      index = newline === -1 ? limit : newline + 1;
    } else if (content.startsWith('/*', index)) {
      const close = content.indexOf('*/', index + 2);
      index = close === -1 ? limit : close + 2;
    } else if (char === '@') {
      const name = /^@[\w.]+\s*/.exec(content.slice(index, index + 200));
      index += name ? name[0].length : 1;
      if (content[index] === '(') {
        index = closingParen(content, index) + 1;
      }
    } else if (char === '[' || (char === '#' && content[index + 1] === '[')) {
      index = closingBracket(content, char === '#' ? index + 1 : index) + 1;
    } else {
      const head = /^[^(;{}=]*?\(/.exec(content.slice(index, index + 400));
      if (!head) {
        return null;
      }
      const before = head[0].slice(0, -1).trimEnd().replace(/<[^<>]*>$/, '').trimEnd();
      return /([A-Za-z_]\w*)$/.exec(before)?.[1] ?? null;
    }
  }
  return null;
}

/** The arguments of an annotation that may or may not take them, and where it ends. */
function readAnnotationArguments(content: string, after: number): { args: string | null; end: number } {
  const gap = /^\s*/.exec(content.slice(after, after + 50))?.[0].length ?? 0;
  if (content[after + gap] !== '(') {
    return { args: null, end: after };
  }
  const open = after + gap;
  const close = closingParen(content, open);
  return { args: content.slice(open + 1, close), end: close + 1 };
}

/** The contiguous run of annotation/attribute lines around `index`. */
function annotationBlock(content: string, index: number): { start: number; end: number } {
  const isAnnotationLine = (line: string): boolean => /^\s*(@|\[|$)/.test(line);
  let start = content.lastIndexOf('\n', index - 1) + 1;
  while (start > 0) {
    const previousStart = content.lastIndexOf('\n', start - 2) + 1;
    if (!isAnnotationLine(content.slice(previousStart, start - 1))) {
      break;
    }
    start = previousStart;
  }
  let end = content.indexOf('\n', index);
  while (end !== -1) {
    const nextEnd = content.indexOf('\n', end + 1);
    const line = content.slice(end + 1, nextEnd === -1 ? content.length : nextEnd);
    if (!isAnnotationLine(line) || line.trim() === '') {
      break;
    }
    end = nextEnd;
  }
  return { start, end: end === -1 ? content.length : end };
}

/** The index of the `)` matching the `(` at `open`, skipping string literals; bounded. */
function closingParen(content: string, open: number): number {
  return closingDelimiter(content, open, '(', ')');
}

function closingBracket(content: string, open: number): number {
  return closingDelimiter(content, open, '[', ']');
}

function closingDelimiter(content: string, open: number, opener: string, closer: string): number {
  let depth = 0;
  const limit = Math.min(content.length, open + MAX_ARGUMENT_SCAN);
  for (let index = open; index < limit; index += 1) {
    const char = content[index];
    if (char === '"' || char === "'" || char === '`') {
      const close = content.indexOf(char, index + 1);
      const newline = char === '`' ? -1 : content.indexOf('\n', index + 1);
      if (close === -1 || (newline !== -1 && newline < close)) {
        continue;
      }
      index = close;
    } else if (char === opener) {
      depth += 1;
    } else if (char === closer) {
      depth -= 1;
      if (depth === 0) {
        return index;
      }
    }
  }
  return limit;
}

function lineStarts(content: string): number[] {
  const starts = [0];
  for (let index = 0; index < content.length; index += 1) {
    if (content.charCodeAt(index) === 10) {
      starts.push(index + 1);
    }
  }
  return starts;
}

function lineAt(starts: number[], offset: number): number {
  let low = 0;
  let high = starts.length - 1;
  while (low < high) {
    const mid = (low + high + 1) >> 1;
    if ((starts[mid] ?? 0) <= offset) {
      low = mid;
    } else {
      high = mid - 1;
    }
  }
  return low + 1;
}

function dedupeRoutes(routes: CodeRoute[]): CodeRoute[] {
  const seen = new Set<string>();
  return routes
    .filter((route) => {
      const key = `${route.line}\u0000${route.method}\u0000${route.path}`;
      if (seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    })
    .sort((a, b) => a.line - b.line || a.path.localeCompare(b.path) || a.method.localeCompare(b.method));
}
