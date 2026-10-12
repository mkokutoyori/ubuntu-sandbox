#include <stdio.h>
int audit_open(void){return 7;}
void audit_close(int fd){}
int audit_log_acct_message(int fd,int type,const char*pg,const char*op,const char*name,unsigned id,const char*host,const char*addr,const char*tty,int res){
 fprintf(stderr,"AUDIT type=%d op=[%s] name=[%s] id=%d host=[%s] addr=[%s] tty=[%s] res=%d\n",type,op,name?name:"(null)",(int)id,host?host:"(null)",addr?addr:"(null)",tty?tty:"(null)",res);return 1;}
int audit_log_user_message(int fd,int type,const char*msg,const char*host,const char*addr,const char*tty,int res){
 fprintf(stderr,"AUDITU type=%d msg=[%s] res=%d\n",type,msg,res);return 1;}
int audit_log_user_comm_message(int fd,int type,const char*msg,const char*comm,const char*host,const char*addr,const char*tty,int res){
 fprintf(stderr,"AUDITC type=%d msg=[%s] res=%d\n",type,msg,res);return 1;}
int audit_send_user_message(int fd,int type,int mode,const char*msg){fprintf(stderr,"AUDITS type=%d msg=[%s]\n",type,msg);return 1;}
