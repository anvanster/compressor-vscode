const esbuild = require('esbuild');

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

/**
 * @type {import('esbuild').Plugin}
 */
const esbuildProblemMatcherPlugin = {
    name: 'esbuild-problem-matcher',
    setup(build) {
        build.onStart(() => {
            console.log('[watch] build started');
        });
        build.onEnd((result) => {
            result.errors.forEach(({ text, location }) => {
                console.error(`✘ [ERROR] ${text}`);
                console.error(`    ${location.file}:${location.line}:${location.column}:`);
            });
            console.log('[watch] build finished');
        });
    },
};

async function main() {
    const ctx = await esbuild.context({
        entryPoints: ['src/extension.ts'],
        bundle: true,
        format: 'cjs',
        minify: production,
        sourcemap: !production,
        sourcesContent: false,
        platform: 'node',
        outfile: 'out/extension.js',
        external: ['vscode'],
        // Standard CJS shim for import.meta.url: the bundled library
        // (@astudioplus/compressor is ESM) derives paths from import.meta.url,
        // which esbuild's CJS output otherwise rewrites to `{}` (undefined
        // .url → TypeError at call time). The banner defines a valid file URL
        // for the bundle itself.
        banner: {
            js: "const import_meta_url = require('url').pathToFileURL(__filename).href;",
        },
        define: { 'import.meta.url': 'import_meta_url' },
        logLevel: 'silent',
        plugins: [
            /* add to the end of plugins array */
            esbuildProblemMatcherPlugin,
        ],
    });
    if (watch) {
        await ctx.watch();
    } else {
        await ctx.rebuild();
        await ctx.dispose();
    }
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
