'use strict';

const Promise = require( 'bluebird' );
const checkType = require( './input-validator' );

let core;

function Autogen( uri, callback ) {
	const self = this;
	let query;
	Promise.try( () => {
		( { query } = checkType.normalizeUrl( uri ) );
		checkType( query, 'mingen', 'zoom' );
		self.mingen = query.mingen;
		checkType( query, 'maxgen', 'zoom' );
		self.maxgen = query.maxgen;
		checkType( query, 'minstore', 'zoom' );
		self.minstore = query.minstore;
		checkType( query, 'maxstore', 'zoom' );
		self.maxstore = query.maxstore;
		checkType( query, 'storage', 'string', true );
		checkType( query, 'generator', 'string', true );
		return core.loadSource( query.storage );
	} ).then( ( storage ) => {
		self.storage = storage;
		return core.loadSource( query.generator );
	} ).then( ( generator ) => {
		self.generator = generator;
	} ).return( this )
		.nodeify( callback );
}

Autogen.prototype.getTile = function getTile( z, x, y, callback ) {
	const self = this;
	return self.storage
		.getTileAsync( z, x, y )
		.catch( ( err ) => {
			if ( ( self.mingen !== undefined && z < self.mingen ) ||
        ( self.maxgen !== undefined && z > self.maxgen ) ||
        !core.isNoTileError( err )
			) {
				throw err;
			}
			let p = self.generator.getTileAsync( z, x, y );
			if (
				( self.minstore === undefined || z >= self.minstore ) &&
        ( self.maxstore === undefined || z <= self.maxstore )
			) {
				// on error, log and ignore
				p = p.spread( ( tile, headers ) =>
					self.storage.putTileAsync( z, x, y, tile )
						.catch( ( err2 ) => core.log( 'error', err2 ) )
						.return( [ tile, headers ] ) );
			}
			return p;
		} ).nodeify( callback, { spread: true } );
};

Autogen.prototype.getInfo = function getInfo( callback ) {
	return this.storage.getInfo( callback );
};

Autogen.initKartotherian = function initKartotherian( cor ) {
	core = cor;
	core.tilelive.protocols[ 'autogen:' ] = Autogen;
};

module.exports = Autogen;
