'use strict';

import * as path from 'path';
import * as cp from 'child_process';
import ChildProcess = cp.ChildProcess;

import * as vscode from 'vscode';
import { stringify } from 'querystring';
import { AssertionError } from 'assert';

const outputChannel = vscode.window.createOutputChannel("Silq");
export default class SilqRunner{
    private diagnosticCollection!: vscode.DiagnosticCollection;
    private outputChannel!: vscode.OutputChannel;
    private historyEnabled=false;
    private historyChannel:vscode.OutputChannel|undefined=undefined;
    private disableAutoRun=0;
    activate(subscriptions: { dispose(): any; }[]) {
        subscriptions.push(this);
        this.diagnosticCollection = vscode.languages.createDiagnosticCollection();
        vscode.workspace.onDidOpenTextDocument(this.checkAll, this, subscriptions);
        vscode.workspace.onDidSaveTextDocument(this.checkAll, this);
        // vscode.workspace.onDidChangeTextDocument(this.checkEvent, this, subscriptions); // TODO
        vscode.workspace.onDidCloseTextDocument((textDocument) => {
                this.diagnosticCollection.delete(textDocument.uri);
        }, null, subscriptions);
        // register run command
        let self=this;
        let getRunCommand=function(doTrace:boolean){
            return ()=>{
                let editorOrUndefined=vscode.window.activeTextEditor;
                if(editorOrUndefined!==undefined){
                    let editor=editorOrUndefined;
                    if(editor.document.isDirty){
                        self.disableAutoRun+=1;
                        editor.document.save().then((_)=>{
                            self.disableAutoRun-=1;
                            self.perform(editor.document, true, doTrace);
                        });
                    }else{
                        self.perform(editor.document, true, doTrace);
                    }
                }
            }
        };
        vscode.commands.registerCommand("silq.run",getRunCommand(false));
        vscode.commands.registerCommand("silq.trace",getRunCommand(true));
        // type check all open documents
        this.checkAll();
    }
    private checkAll(changed?: vscode.TextDocument|undefined){
        if(changed && changed.languageId !== 'silq') return;
        let autoRun=this.disableAutoRun==0&&vscode.workspace.getConfiguration("silq").get<boolean>("autoRun");
        let historyEnabled=vscode.workspace.getConfiguration("silq").get<boolean>("historyChannel")||false;
        if(historyEnabled){
            if(this.historyChannel===undefined){
                this.historyChannel=vscode.window.createOutputChannel("Silq History");
            }
        }else if(this.historyChannel){
            this.historyChannel.clear();
            this.historyChannel.dispose();
            this.historyChannel=undefined;
        }
        vscode.workspace.textDocuments.forEach((textDocument: vscode.TextDocument)=>{
            if(changed && autoRun && textDocument.uri.toString() == changed.uri.toString()) return this.run(textDocument);
            else return this.check(textDocument);
        }, this);
    }
    private check(textDocument: vscode.TextDocument){
        this.perform(textDocument, false, false);
    }
    private run(textDocument: vscode.TextDocument){
        this.perform(textDocument, true, false);
    }
    private trace(textDocument: vscode.TextDocument){
        this.perform(textDocument, true, true);
    }
    private log(msg: string){
        vscode.window.showInformationMessage(msg);
        console.log(msg);
    }
    private error(msg: string){
        vscode.window.showErrorMessage(msg);
        console.error(msg);
    }
    private getBinaryPath():string|undefined{
        let result=vscode.workspace.getConfiguration("silq").get<string>("binaryPath");
        if(result!==null&&result!==""&&result!=="null") return result;
        let extension = vscode.extensions.getExtension("eth-sri.vscode-silq");
        if(extension === undefined) return undefined;
        let file="silq";
        switch(process.platform){
            case "darwin": file="silq-osx"; break;
            case "win32": file="silq.exe"; break;
            default: break;
        }
        return path.join(extension.extensionPath,"bin",file);
    }
    childProcess: cp.ChildProcess|undefined = undefined;
    private trySpawn(command: string, args: string[], options: cp.SpawnOptions):cp.ChildProcess|undefined{
        try{
            let childProcess=cp.spawn(command, args, options);
            if(childProcess.pid){
                return childProcess;
            }else{
                return undefined;
            }
        }catch(e){
            return undefined;
        }
    }
    private tryParse(output: string): any|undefined{
        let lines = output.split("\n");
        let result = undefined;
        try{
            result = JSON.parse(lines[0]);
        }catch(e){}
        if(result) lines.shift();
        if (lines.length != 0 && !(lines.length == 1 && lines[0] == "")) {
            outputChannel.appendLine("ERROR:");
            outputChannel.appendLine(lines.join("\n"));
            outputChannel.show(true);
        }
        return result;
    }
    private perform(textDocument: vscode.TextDocument, doRun: boolean, doTrace: boolean){
        if(textDocument.languageId !== 'silq') return;
        let executable = this.getBinaryPath();
        if(executable===null){
            this.error("Error: can't run silq. You may need to set silq.binaryPath.");
            return;
        }
        let args = ['--error-json', textDocument.fileName];
        if(doRun) args.push('--run');
        if(doTrace) args.push('--trace');
        let moreArgs=vscode.workspace.getConfiguration("silq").get<string>("commandLineOptions");
        if(moreArgs) moreArgs.split(" ").forEach((arg) => { args.push(arg); });
        let options = { cwd: path.dirname(textDocument.fileName) };
        if(doRun&&this.childProcess){
            this.childProcess.kill();
            this.log("Previous silq process killed.");
        }
        let childProcessOrUndef = this.trySpawn(executable as string, args, options);
        if(doRun){
            this.childProcess = childProcessOrUndef;
            outputChannel.clear();
            outputChannel.appendLine("running "+textDocument.fileName+"...");
            //outputChannel.show(true);
        }
        let output = '';
        let diagnostics: vscode.Diagnostic[] = [];
        if(childProcessOrUndef){
            let childProcess=childProcessOrUndef;
            childProcess.stderr.on('data',(data: Buffer) => {
                output += data;
            });
            let first = true;
            let ended = false;
            if(doRun){
                childProcess.stdout.on('data',(data: Buffer) => {
                    if(first){
                        outputChannel.clear();
                        first=false;
                    }
                    outputChannel.append(data.toString());
                    if(this.historyChannel){
                        this.historyChannel.append(data.toString());
                    }
                    outputChannel.show(true);
                });
            }
            childProcess.stderr.on('end', () => {
                let json=this.tryParse(output);
                if(!json){
                    if(doRun){
                        this.childProcess=undefined;
                    }
                    return;
                }
                json.map((item:any):vscode.Diagnostic|null => {
                    let source = item.source as string;
                    let uri=vscode.Uri.file(source);
                    if(uri.toString()!==textDocument.uri.toString()) return null; // TODO: ok?
                    let range = new vscode.Range(item.start.line-1, item.start.column, item.end.line-1, item.end.column);
                    let message = item.message as string;
                    let severity = item.severity === "error" ? vscode.DiagnosticSeverity.Error :
                                   item.severity === "note" ? vscode.DiagnosticSeverity.Hint :
                                   vscode.DiagnosticSeverity.Warning;
                    let diagnostic = new vscode.Diagnostic(range,message,severity);
                    diagnostic.relatedInformation = item.relatedInformation.map((ritem:any)=>{
                        let source = ritem.source as string;
                        let range = new vscode.Range(ritem.start.line-1, ritem.start.column, ritem.end.line-1, ritem.end.column);
                        let message = ritem.message as string;
                        return new vscode.DiagnosticRelatedInformation(new vscode.Location(textDocument.uri, range), message);
                    });
                    return diagnostic;
                }).forEach((diagnostic: vscode.Diagnostic|null) => {
                    if(diagnostic === null) return;
                    diagnostics.push(diagnostic);
                });
                if(doRun){
                    let handleStdoutEnd=()=>{
                        if(first){
                            outputChannel.clear();
                        }else{
                            outputChannel.appendLine("\n");
                        }
                        if(diagnostics.length===0){
                            if(!first){
                                outputChannel.appendLine("Result for "+textDocument.fileName);
                            }
                        }else{
                            outputChannel.appendLine("Errors in "+textDocument.fileName+" (see \"problems\" window)");
                        }
                        first=false;
                        this.diagnosticCollection.set(textDocument.uri, diagnostics);
                        this.childProcess=undefined;
                    };
                    if(childProcess.stdout.readable) childProcess.stdout.on('end',handleStdoutEnd);
                    else handleStdoutEnd();
                }else{
                    this.diagnosticCollection.set(textDocument.uri, diagnostics);
                }
            });
        }else{
            this.error("Error: can't run silq. You may need to set silq.binaryPath.");
            if(doRun) this.childProcess=undefined;
        }
    }
    public dispose(): void {
        this.diagnosticCollection.clear();
        this.diagnosticCollection.dispose();
    }
}
