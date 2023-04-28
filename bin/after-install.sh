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

cd /opt/fwcloud/websrv
./upgrade-cert.sh websrv

# Make sure that all files are owned by the fwcloud user and group.
cd /opt/fwcloud
chown -R fwcloud:fwcloud ui && chmod 750 ui
chown -R fwcloud:fwcloud websrv && chmod 750 websrv

exit 0
