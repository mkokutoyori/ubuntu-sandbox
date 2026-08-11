/**
 * Les fichiers que Debian/Ubuntu posent pour rsyslog.
 *
 * Ce que la mesure a trouve : `rsyslogd` EXISTE dans `/usr/sbin`,
 * `systemctl status rsyslog` repond `active (running)`, `/var/log/syslog`
 * se remplit — et **`/etc/rsyslog.conf` n'existe pas**, `/etc/rsyslog.d/`
 * non plus, et **rien n'ecoute sur le port 514**. Un routeur Cisco
 * configure avec `logging host` posait donc de VRAIS datagrammes sur le
 * fil que PERSONNE ne recevait.
 *
 * C'est la meme forme que le defaut deja referme pour nginx et apache —
 * une unite qui se declare active sans rien derriere — et cela vide de
 * son sens la partie centrale d'un cours sur syslog : la centralisation.
 * Les parties « editer /etc/rsyslog.conf », « un fichier par equipement »
 * et « chercher dans les logs recus » n'avaient aucun support.
 *
 * Le contenu est celui de Debian et non un minimum invente : c'est le
 * fichier qu'un apprenant ouvre, et les lignes qu'il decommente
 * (`imudp`, `imtcp`) sont precisement l'exercice.
 */

export const RSYSLOG_CONF_PATH = '/etc/rsyslog.conf';
export const RSYSLOG_D_DIR = '/etc/rsyslog.d';

/**
 * `/etc/rsyslog.conf` de Debian 12 / Ubuntu 22.04.
 *
 * Les modules de reception sont **commentes**, comme sur une vraie
 * machine : un rsyslog fraichement installe n'ecoute PAS sur 514. Les
 * decommenter est le premier geste du laboratoire de centralisation, et
 * livrer un fichier ou ils seraient deja actifs supprimerait l'exercice
 * en meme temps que la verite.
 */
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

/** `/etc/rsyslog.d/50-default.conf` — les regles de routage de Debian. */
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

/** Ce que l'image pose au demarrage. */
export const RSYSLOG_SEEDED_FILES: ReadonlyArray<readonly [string, string]> = [
  [RSYSLOG_CONF_PATH, RSYSLOG_CONF_DEBIAN],
  [`${RSYSLOG_D_DIR}/50-default.conf`, RSYSLOG_50_DEFAULT],
];
