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

cd /opt/fwcloud/websrv/bin
mkdir ../config/tls
./update-cert.sh websrv >/dev/null

# Make sure that all files are owned by the fwcloud user and group.
cd /opt/fwcloud
chown -R fwcloud:fwcloud ui && chmod 750 ui
chown -R fwcloud:fwcloud websrv && chmod 750 websrv

# Disable check for updates in FWCloud-UI.
echo '{ "checkUpdates": false }' > /opt/fwcloud/ui/dist/assets/config/config.json

# Enable and start FWCloud-Websrv service.
systemctl enable fwcloud-websrv
systemctl start fwcloud-websrv

exit 0
