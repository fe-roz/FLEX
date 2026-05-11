const serverConfig = {
    // Server configuration
    server: {
        port: 8081,
        address: '127.0.0.1'
    },

    // Proxy configuration
    proxy: {
        // Whitelist of domains allowed for proxying
        // Each entry can be a string (exact match) or a regular expression
        whitelist: [
            '127.0.0.1',
            'localhost',
            /^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/,
            /^192\.168\.\d{1,3}\.\d{1,3}$/,
            /^172\.(1[6-9]|2\d|3[0-1])\.\d{1,3}\.\d{1,3}$/,
            'usgs.entwine.io',
            'caltopo.com',
            'ngmdb-tiles.usgs.gov',
            'services.arcgisonline.com',
            'basemap.nationalmap.gov',
            'tiles.arcgis.com',
            'portal.opentopography.org',
            'mapservices.weather.noaa.gov',
            'stamen-tiles.a.ssl.fastly.net',
            'api.example.com',
            'data.example.org',
            'ot-process2.sdsc.edu',
            'noaa-nos-coastal-lidar-pds.s3.amazonaws.com',
            'tiles.maps.eox.at',
            'tile.openstreetmap.org',
            'a.tile.openstreetmap.org',
            'b.tile.openstreetmap.org',
            'c.tile.openstreetmap.org',
        ]
    },
    backend: {
        baseUrl: 'http://10.3.90.211:8083',
        autoLoadCatalog: true
    }
};

if (typeof module !== 'undefined' && module.exports) {
    // Node.js environment
    module.exports = serverConfig;
} else {
    // Browser environment
    window.serverConfig = serverConfig;
}
