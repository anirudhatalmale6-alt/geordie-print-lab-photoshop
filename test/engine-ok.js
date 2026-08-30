/**
 * Is this engine file one this plugin can actually use?
 *
 * Run against a freshly downloaded engine BEFORE it is installed.
 *
 * The point is freshness, not identity. A stale engine is still a perfectly
 * valid engine file, so "does it look like the engine" cannot catch one - and
 * a fixed marker like ENGINE_API cannot either, because every past version had
 * it too. What only the CURRENT engine has is knowledge of everything the
 * current plugin sends it, so that is what gets checked. It needs no
 * maintenance: the day the plugin gains a setting, this guard starts demanding
 * an engine that knows about it.
 *
 *   node test/engine-ok.js <path-to-engine.js>
 */

'use strict';

const fs = require( 'fs' );
const path = require( 'path' );

const studio = require( path.join( __dirname, '..', 'studio.js' ) );

const target = process.argv[ 2 ];

if ( ! target ) {
	console.error( 'usage: engine-ok.js <path-to-engine.js>' );
	process.exit( 2 );
}

const src = fs.readFileSync( target, 'utf8' );

if ( src.indexOf( 'ENGINE_API' ) === -1 ) {
	console.error( 'that engine publishes no entry points - the plugin calls run() directly' );
	process.exit( 1 );
}

/* Every setting the plugin sends has to be read somewhere in the engine. One
   it has never heard of means an older file: the setting would be ignored in
   silence, which is the worst way for this to fail - the customer would get a
   result, just not the one they asked for. */
const missing = studio.ENGINE_KEYS.filter(
	( k ) => ! new RegExp( 's\\.' + k + '\\b' ).test( src )
);

if ( missing.length ) {
	console.error(
		'that engine does not understand: ' + missing.join( ', ' ) +
		'\nit is older than this plugin - a stale cache, or the site has not been deployed yet'
	);
	process.exit( 1 );
}

console.log( 'engine understands all ' + studio.ENGINE_KEYS.length + ' settings the plugin sends' );
