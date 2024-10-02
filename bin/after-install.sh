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

# Generate selfsigned TLS certificates.
cd /opt/fwcloud/websrv/bin
mkdir ../config/tls
./update-cert.sh websrv >/dev/null

# Make sure that all files are owned by the fwcloud user and group.
cd /opt/fwcloud
chown -R fwcloud:fwcloud ui && chmod 750 ui
chown -R fwcloud:fwcloud websrv && chmod 750 websrv

# Indicate the install method we have followed for FWCloud installation.
echo '{ "installMethod": "pkg" }' > /opt/fwcloud/ui/dist/assets/config/config.json

# Some Linux distributions have SELinux enabled.
if command -v getenforce >/dev/null 2>&1; then
  if [ $(getenforce) = "Enforcing" ]; then
    # If SELinux is enabled, then load the semodule necessary for start the FWCloud-API service.
    cd /opt/fwcloud/websrv/config/sys/SELinux
    checkmodule -M -m -o fwcloud-websrv.mod fwcloud-websrv.te
    semodule_package -o fwcloud-websrv.pp -m fwcloud-websrv.mod
    semodule -i fwcloud-websrv.pp
  fi
fi

# This is necessary because with FPM we don't have yet an --rpm-systemd option like the --deb-systemd option.
SRVFILE="/lib/systemd/system/fwcloud-websrv.service"
if [ ! -f "$SRVFILE" ]; then
  cp /opt/fwcloud/websrv/config/sys/fwcloud-websrv.service $SRVFILE
  chown root:root $SRVFILE
  chmod 644 $SRVFILE
fi

# Enable and start FWCloud-Websrv service.
systemctl enable fwcloud-websrv
systemctl start fwcloud-websrv

exit 0
