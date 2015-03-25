module.exports = function( grunt ) {
    'use strict';

    function readOptionalJSON( filepath ) {
        var data = {};
        try {
            data = grunt.file.readJSON( filepath );
        } catch ( e ) {}
        return data;
    }

    grunt.initConfig({
        pkg: grunt.file.readJSON( 'package.json' ),
        dst: readOptionalJSON( 'dist/.destination.json' ),
        concat: {
            dist: {
                files: {
                    'dist/carotene.js': ['src/bullet.js', 'src/carotene.js'],
                },
            },
        },
        jsonlint: {
            pkg: {
                src: [ 'package.json' ]
            },

            bower: {
                src: [ 'bower.json' ]
            }
        },
        jshint: {
            all: {
                src: [
                    'src/*.js', 'Gruntfile.js',
                ],
                options: {
                    jshintrc: true
                }
            }
        },
        watch: {
            files: [ '<%= jshint.all.src %>' ],
            tasks: [ 'dev' ]
        },
        uglify: {
            all: {
                files: {
                    'dist/carotene.min.js': [ 'dist/carotene.js' ]
                },
                options: {
                    preserveComments: false,
                    sourceMap: true,
                    sourceMapName: 'dist/carotene.min.map',
                    report: 'min',
                    beautify: {
                        'ascii_only': true
                    },
                    banner: '/*! Carotene v<%= pkg.version %> */',
                    compress: {
                        'hoist_funs': false,
                        loops: false,
                        unused: false
                    }
                }
            }
        }
    });

    grunt.loadNpmTasks('grunt-contrib-uglify');
    grunt.loadNpmTasks('grunt-jsonlint');
    grunt.loadNpmTasks('grunt-contrib-jshint');
    grunt.loadNpmTasks('grunt-contrib-watch');
    grunt.loadNpmTasks('grunt-contrib-concat');

    grunt.registerTask( 'lint', [ 'jsonlint', 'jshint' ] );

    grunt.registerTask( 'default', [ 'lint', 'concat', 'uglify' ] );

};
