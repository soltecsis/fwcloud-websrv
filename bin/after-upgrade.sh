#!/bin/sh
#############################################
##                                         ##
##  FWCloud.net                            ##
##  https://fwcloud.net                    ##
##  info@fwcloud.net                       ##
##                                         ##
##  Developed by SOLTECSIS, S.L.           ##
##  https://soltecsis.com                  ##
##  info@soltecsis.com                     ##
##                                         ##
#############################################

BASEDIR=$(dirname "$0")

cd /opt/fwcloud

# Make sure that all files are owned by the fwcloud user and group.
chown -R fwcloud:fwcloud ui
chown -R fwcloud:fwcloud websrv

# Set root directories permisions.
chmod 750 ui
chmod 750 websrv

exit 0
