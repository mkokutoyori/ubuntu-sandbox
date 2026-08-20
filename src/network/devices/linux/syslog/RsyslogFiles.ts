
export const RSYSLOG_CONF_PATH = '/etc/rsyslog.conf';
export const RSYSLOG_D_DIR = '/etc/rsyslog.d';

export const RSYSLOG_CONF_DEBIAN = `#  /etc/rsyslog.conf	Configuration file for rsyslog.
#
#			For more information install rsyslog-doc and see
#			/usr/share/doc/rsyslog-doc/html/configuration/index.html

#################
#### MODULES ####
#################

module(load="imuxsock")	# provides support for local system logging
module(load="imklog")	# provides kernel logging support

# provides UDP syslog reception
#module(load="imudp")
#input(type="imudp" port="514")

# provides TCP syslog reception
#module(load="imtcp")
#input(type="imtcp" port="514")

###########################
#### GLOBAL DIRECTIVES ####
###########################

#
# Set the default permissions for all log files.
#
$FileOwner root
$FileGroup adm
$FileCreateMode 0640
$DirCreateMode 0755
$Umask 0022

#
# Where to place spool and state files
#
$WorkDirectory /var/spool/rsyslog

#
# Include all config files in /etc/rsyslog.d/
#
$IncludeConfig /etc/rsyslog.d/*.conf
`;

export const RSYSLOG_50_DEFAULT = `#  Default rules for rsyslog.
#
#			For more information see rsyslog.conf(5) and /etc/rsyslog.conf

#
# First some standard log files.  Log by facility.
#
auth,authpriv.*			/var/log/auth.log
*.*;auth,authpriv.none		-/var/log/syslog
kern.*				-/var/log/kern.log
mail.*				-/var/log/mail.log
user.*				-/var/log/user.log

#
# Emergencies are sent to everybody logged in.
#
*.emerg				:omusrmsg:*
`;

export const RSYSLOG_LOGROTATE_PATH = '/etc/logrotate.d/rsyslog';

export const RSYSLOG_LOGROTATE_DEBIAN = `/var/log/syslog
/var/log/mail.log
/var/log/kern.log
/var/log/auth.log
/var/log/user.log
{
	rotate 4
	weekly
	missingok
	notifempty
	compress
	delaycompress
	sharedscripts
	postrotate
		/usr/lib/rsyslog/rsyslog-rotate
	endscript
}
`;

export const RSYSLOG_SEEDED_FILES: ReadonlyArray<readonly [string, string]> = [
  [RSYSLOG_CONF_PATH, RSYSLOG_CONF_DEBIAN],
  [`${RSYSLOG_D_DIR}/50-default.conf`, RSYSLOG_50_DEFAULT],
  [RSYSLOG_LOGROTATE_PATH, RSYSLOG_LOGROTATE_DEBIAN],
];
