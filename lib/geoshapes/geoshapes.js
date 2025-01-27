'use strict';

const topojson = require( 'topojson' );
const Err = require( '../err' );
const preq = require( 'preq' );
const parseWikidataValue = require( 'wd-type-parser' );

const simpleStyleProperties = {
	fill_opacity: 'fill-opacity',
	marker_color: 'marker-color',
	marker_size: 'marker-size',
	marker_symbol: 'marker-symbol',
	stroke_opacity: 'stroke-opacity',
	stroke_width: 'stroke-width'
};

const floatRegex = /-?[0-9]+(\.[0-9]+)?/;

class GeoShapes {
	/**
	 * @param {string} type
	 * @param {Object} reqParams
	 * @param {string} reqParams.ids
	 * @param {string} reqParams.query
	 * @param {string} reqParams.idcolumn
	 * @param {string} reqParams.sql
	 * @param {Object} config
	 */
	constructor( type, reqParams, config ) {
		this.config = config;

		if ( !reqParams.ids && !reqParams.query ) { throw new Err( '"ids" or "query" parameter must be given' ); }
		if ( reqParams.query && !this.config.wikidataQueryService ) { throw new Err( '"query" parameter is not enabled' ); }

		if ( reqParams.ids ) {
			this.ids = reqParams.ids.split( ',' ).filter( ( id ) => id !== '' );
			if ( this.ids.length > this.config.maxidcount ) { throw new Err( 'No more than %d IDs is allowed', this.config.maxidcount ); }
			this.ids.forEach( ( val ) => {
				if ( !/^Q[1-9][0-9]{0,15}$/.test( val ) ) { throw new Err( 'Invalid Wikidata ID' ); }
			} );
		} else {
			this.ids = [];
		}
		this.type = type;
		this.metric = type + ( reqParams.query ? '.wdqs' : '.ids' );
		this.sparqlQuery = reqParams.query;
		this.isDefaultIdColumn = !reqParams.idcolumn;
		this.idColumn = reqParams.idcolumn || 'id';
		this.geoColumn = 'geo';
		this.useGeoJson = !!reqParams.getgeojson;
		this.reqParams = reqParams;
		this.db = config.db;
	}

	/**
	 * Main execution method
	 *
	 * @param {string} xClientIp
	 * @return {Object}
	 */
	async execute( xClientIp ) {
		const rawProperties = await this._runWikidataQuery( xClientIp );
		const ids = this.ids.concat( Object.keys( rawProperties ) );
		const [ geoRows, cleanProperties ] = await Promise.all( [
			this._runSqlQuery( ids ),
			this._expandProperties( rawProperties )
		] );

		return await this._wrapResult( geoRows, cleanProperties, this.useGeoJson );
	}

	/**
	 *
	 * @param {string} xClientIp
	 * @return {Object}
	 */
	async _runWikidataQuery( xClientIp ) {
		// If there is no query, we only use the ids given in the request
		if ( !this.sparqlQuery ) { return {}; }

		const queryResult = await preq.get( {
			uri: this.config.wikidataQueryService,
			query: {
				format: 'json',
				query: this.sparqlQuery
			},
			headers: Object.assign( this.config.sparqlHeaders, { 'X-Client-IP': xClientIp } )

		} );
		if ( !queryResult.headers[ 'content-type' ].startsWith( 'application/sparql-results+json' ) ) {
			throw new Err( 'Unexpected content type %s', queryResult.headers[ 'content-type' ] );
		}
		const data = queryResult.body;
		if ( !data.results || !Array.isArray( data.results.bindings ) ) {
			throw new Err( 'SPARQL query result does not have "results.bindings"' );
		}

		return data.results.bindings.reduce( ( rawProperties, wd ) => {
			const [ id, result ] = this._processResultRow( wd );
			if ( id in rawProperties ) {
				throw new Err( 'SPARQL query result contains non-unique ID %j', id );
			}
			rawProperties[ id ] = result;
			return rawProperties;
		}, {} );
	}

	/**
	 * Handle one wikidata query result row
	 *
	 * @param {Object} wd
	 * @return {string}
	 */
	_processResultRow( wd ) {
		if ( !( this.idColumn in wd ) ) {
			let errMsg = 'SPARQL query result does not contain %j column.';
			if ( this.isDefaultIdColumn ) {
				errMsg += ' Use idcolumn argument to specify column name, or change the query to return "id" column.';
			}
			throw new Err( errMsg, this.idColumn );
		}
		const { [ this.idColumn ]: value, ...result } = wd;
		const id = parseWikidataValue( value, true );
		if ( !id || value.type !== 'uri' ) {
			throw new Err( 'SPARQL query result id column %j is expected to be a valid Wikidata ID', this.idColumn );
		}
		if ( wd[ this.geoColumn ] ) {
			result.coordinate = parseWikidataValue( wd[ this.geoColumn ], true );
		}

		// further parsing will be done later, once we know the object actually
		// exists in the OSM db
		return [ id, result ];
	}

	/**
	 * Retrieve all geo shapes for the given list of IDs
	 *
	 * @param {string[]} ids
	 * @return {Array}
	 */
	async _runSqlQuery( ids ) {
		if ( ids.length === 0 || this.type === 'geopoint' ) { return []; }
		const args = [ this.type === 'geoshape' ? this.config.polygonTable : this.config.lineTable, ids ];
		const query = this.config.queries[ this.reqParams.sql ] || this.config.queries.default;

		if ( query.params ) {
			query.params.forEach( ( param ) => {
				const paramName = param.name;
				if ( !paramName || !this.reqParams[ paramName ] ) {
					// If param name is NOT defined, we always use default,
					// without allowing user to customize it
					args.push( param.default );
				} else {
					const value = this.reqParams[ paramName ];
					if ( floatRegex.test( value ) ) { throw new Err( 'Invalid value for param %s', paramName ); }
					args.push( value );
				}
			} );
		}

		return await this.db.query( query.sql, args );
	}

	/**
	 * @param {Object} rawProperties
	 * @return {Object}
	 */
	async _expandProperties( rawProperties ) {
		// Create fake geojson with the needed properties, and sanitize them via api
		// We construct valid GeoJSON with each property object in this form:
		// {
		//     "type": "Feature",
		//     "id": "...",
		//     "properties": {...},
		//     "geometry": {"type": "Point", "coordinates": [0,0]}
		// }
		const props = [];

		Object.keys( rawProperties ).forEach( ( id ) => {
			if ( rawProperties[ id ] ) {
				const prop = rawProperties[ id ];
				Object.keys( prop ).forEach( ( key ) => {
					if ( prop[ key ] ) {
						// If this is a simplestyle property with a '_' in the name instead of '-',
						// convert it to the proper syntax.
						// SPARQL is unable to produce columns with a '-' in the name.
						const newKey = simpleStyleProperties[ key ];
						const value = parseWikidataValue( prop[ key ] );
						if ( newKey ) {
							prop[ newKey ] = value;
							delete prop[ key ];
						} else {
							prop[ key ] = value;
						}
					}
				} );
				props.push( {
					type: 'Feature',
					id,
					properties: prop,
					geometry: { type: 'Point', coordinates: [ 0, 0 ] }
				} );
			}
		} );

		if ( !props.length ) { return undefined; }

		const apiResult = await preq.post( {
			uri: this.config.mwapi,
			formData: {
				format: 'json',
				formatversion: 2,
				action: 'sanitize-mapdata',
				text: JSON.stringify( props )
			},
			headers: this.config.mwapiHeaders

		} );

		if ( apiResult.body.error ) { throw new Err( apiResult.body.error ); }
		const body = apiResult.body[ 'sanitize-mapdata' ];
		if ( !body ) {
			throw new Err( 'Unexpected api action=sanitize-mapdata results' );
		}
		if ( body.error ) { throw new Err( body.error ); }
		if ( !body.sanitized ) {
			throw new Err( 'Unexpected api action=sanitize-mapdata results' );
		}
		const sanitized = JSON.parse( body.sanitized );
		if ( !sanitized || !Array.isArray( sanitized ) ) {
			throw new Err( 'Unexpected api action=sanitize-mapdata sanitized value results' );
		}
		return sanitized.reduce( ( cleanProperties, s ) => {
			cleanProperties[ s.id ] = s.properties;
			return cleanProperties;
		}, {} );
	}

	/**
	 * @param {Array} rows
	 * @param {Object} properties
	 * @param {boolean} useGeoJson
	 * @return {Object}
	 */
	_wrapResult( rows, properties, useGeoJson ) {
		// If no result, return an empty result set - which greatly simplifies processing
		let features = [];

		if ( this.type === 'geopoint' && properties ) {
			for ( const [ key, value ] of Object.entries( properties ) ) {
				delete value[ this.idColumn ];
				const coordinates = value[ this.geoColumn ];
				delete value[ this.geoColumn ];
				const feature = {
					type: 'Feature',
					id: key,
					properties: value,
					geometry:
						{
							type: 'Point',
							coordinates
						}
				};
				features.push( feature );
			}
		} else if ( rows ) {
			features = rows.map( ( row ) => {
				const feature = {
					type: 'Feature',
					id: String( row.id ),
					properties: {},
					geometry: JSON.parse( row.data )
				};
				if ( properties ) {
					const wd = properties[ row.id ];
					if ( wd ) {
						feature.properties = wd;
					}
				}
				return feature;
			} );
		}

		// TODO: Would be good to somehow monitor the average/min/max number of features
		// core.metrics.count(geoshape.metric, features.length);

		const result = {
			type: 'FeatureCollection',
			features
		};
		if ( !useGeoJson ) {
			return topojson.topology( { data: result }, {
				// preserve all properties
				'property-transform': ( feature ) => feature.properties
			} );
		}
		return result;
	}
}

module.exports = GeoShapes;
