import * as fs from 'fs';
import * as path from 'path';
import { FileEntry, ProjectIndex } from './types';

// ── Framework detection ───────────────────────────────────────────────────────
//
// ORDER MATTERS — check backend/fullstack markers BEFORE package.json.
// Many backend frameworks (Laravel, Spring, Django, Rails) have a package.json
// for their frontend build tool (Vite, Webpack, Mix) — that must NOT override
// the real framework.

function detectFramework(rootPath: string): string {

  // ── PHP ──────────────────────────────────────────────────────────────────
  // Laravel: has artisan file at root
  if (fs.existsSync(path.join(rootPath, 'artisan'))) {
    return 'Laravel';
  }
  // Generic PHP / Symfony / Lumen
  if (fs.existsSync(path.join(rootPath, 'composer.json'))) {
    try {
      const composer = JSON.parse(fs.readFileSync(path.join(rootPath, 'composer.json'), 'utf8'));
      const require  = { ...composer.require, ...composer['require-dev'] };
      if (require['symfony/framework-bundle']) { return 'Symfony'; }
      if (require['laravel/lumen-framework'])  { return 'Lumen';   }
    } catch { /* ignore */ }
    return 'PHP';
  }

  // ── Java / Kotlin ────────────────────────────────────────────────────────
  if (fs.existsSync(path.join(rootPath, 'pom.xml'))) {
    try {
      const pom = fs.readFileSync(path.join(rootPath, 'pom.xml'), 'utf8');
      if (pom.includes('spring-boot')) { return 'Spring Boot'; }
    } catch { /* ignore */ }
    return 'Maven / Java';
  }
  if (fs.existsSync(path.join(rootPath, 'build.gradle')) ||
      fs.existsSync(path.join(rootPath, 'build.gradle.kts'))) {
    try {
      const gradle = fs.readFileSync(
        path.join(rootPath, fs.existsSync(path.join(rootPath, 'build.gradle.kts')) ? 'build.gradle.kts' : 'build.gradle'),
        'utf8'
      );
      if (gradle.includes('org.springframework.boot')) { return 'Spring Boot'; }
    } catch { /* ignore */ }
    return 'Gradle / Java';
  }

  // ── Python ───────────────────────────────────────────────────────────────
  if (fs.existsSync(path.join(rootPath, 'requirements.txt')) ||
      fs.existsSync(path.join(rootPath, 'pyproject.toml'))    ||
      fs.existsSync(path.join(rootPath, 'Pipfile'))) {
    try {
      // Try to detect Django vs FastAPI vs Flask from requirements
      const req = fs.existsSync(path.join(rootPath, 'requirements.txt'))
        ? fs.readFileSync(path.join(rootPath, 'requirements.txt'), 'utf8').toLowerCase()
        : '';
      if (req.includes('django'))  { return 'Django';  }
      if (req.includes('fastapi')) { return 'FastAPI'; }
      if (req.includes('flask'))   { return 'Flask';   }
    } catch { /* ignore */ }
    return 'Python';
  }

  // ── Ruby ─────────────────────────────────────────────────────────────────
  if (fs.existsSync(path.join(rootPath, 'Gemfile'))) {
    try {
      const gemfile = fs.readFileSync(path.join(rootPath, 'Gemfile'), 'utf8');
      if (gemfile.includes("'rails'") || gemfile.includes('"rails"')) { return 'Ruby on Rails'; }
    } catch { /* ignore */ }
    return 'Ruby';
  }

  // ── Go ───────────────────────────────────────────────────────────────────
  if (fs.existsSync(path.join(rootPath, 'go.mod'))) {
    try {
      const goMod = fs.readFileSync(path.join(rootPath, 'go.mod'), 'utf8');
      if (goMod.includes('gin-gonic/gin'))  { return 'Go / Gin';   }
      if (goMod.includes('gofiber/fiber'))  { return 'Go / Fiber'; }
    } catch { /* ignore */ }
    return 'Go';
  }

  // ── Rust ─────────────────────────────────────────────────────────────────
  if (fs.existsSync(path.join(rootPath, 'Cargo.toml'))) {
    return 'Rust';
  }

  // ── .NET ─────────────────────────────────────────────────────────────────
  const csprojFiles = fs.readdirSync(rootPath).filter(f => f.endsWith('.csproj'));
  if (csprojFiles.length > 0) {
    try {
      const csproj = fs.readFileSync(path.join(rootPath, csprojFiles[0]), 'utf8');
      if (csproj.includes('Microsoft.AspNetCore')) { return 'ASP.NET Core'; }
    } catch { /* ignore */ }
    return '.NET';
  }

  // ── JavaScript / TypeScript (checked LAST) ───────────────────────────────
  // Only reach here if no backend marker was found above
  if (fs.existsSync(path.join(rootPath, 'package.json'))) {
    try {
      const pkg  = JSON.parse(fs.readFileSync(path.join(rootPath, 'package.json'), 'utf8'));
      const deps = { ...pkg.dependencies, ...pkg.devDependencies };
      if (deps['next'])           { return 'Next.js';  }
      if (deps['nuxt'])           { return 'Nuxt';     }
      if (deps['@remix-run/react']) { return 'Remix';  }
      if (deps['gatsby'])         { return 'Gatsby';   }
      if (deps['react'])          { return 'React';    }
      if (deps['vue'])            { return 'Vue';      }
      if (deps['svelte'])         { return 'Svelte';   }
      if (deps['@angular/core'])  { return 'Angular';  }
      if (deps['express'])        { return 'Express';  }
      if (deps['fastify'])        { return 'Fastify';  }
      if (deps['koa'])            { return 'Koa';      }
      if (deps['hapi'] || deps['@hapi/hapi']) { return 'Hapi'; }
      // Has package.json but no recognised framework
      return pkg.name ? `Node.js (${pkg.name})` : 'Node.js';
    } catch { /* ignore */ }
  }

  return 'Unknown';
}

// ─────────────────────────────────────────────────────────────────────────────

export function buildIndex(
  rootPath: string,
  files: FileEntry[]
): ProjectIndex {
  const layers: Record<string, string[]> = {};

  for (const file of files) {
    if (!layers[file.layer]) { layers[file.layer] = []; }
    layers[file.layer].push(file.relativePath);
  }

  return {
    root: rootPath,
    framework: detectFramework(rootPath),
    totalFiles: files.length,
    files,
    layers,
  };
}